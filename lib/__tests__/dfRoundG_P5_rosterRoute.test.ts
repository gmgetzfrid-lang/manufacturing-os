// drafting-flow Round G, DF-P5 ROSTER — the workflow route: a routed library
// opens a parallel roster on submission (GAP-103 / GAP-112), sign-offs are
// e-signatures bound to the content hash (EVID-12), the last one issues the
// ticket (TIER-5), independence per slot (DEC-37), fail closed on every read
// the routing needs (DEC-36), today's path for every unconfigured ticket and
// before either paste (REGRESSION), issue-as-is (FRIC-5), the approved drafts'
// server-computed sha256 (EVID-12).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { __resetCapabilityPolicyCache } from "@/lib/capabilityPolicy";
import type { TicketAttachment, TicketReviewRoster } from "@/types/schema";

const LM = "2026-10-21T00:00:00.000Z";
const LIB = "1b000000-0000-4000-8000-000000000001";
const SIG = "5a000000-0000-4000-8000-000000000001";
const SIG2 = "5a000000-0000-4000-8000-000000000002";
const BYTES = "%PDF-1.7 the draft";
const SHA = createHash("sha256").update(BYTES).digest("hex");

// ── the route harness (vi.hoisted state + a Proxy chain for supabaseAdmin) ──
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  errors: {} as Record<string, { code?: string; message: string }>,
  r2: [] as Array<{ kind: string; key: string }>,
  r2Fail: false,
  r2Hang: false,
  after: [] as Array<() => unknown>,
}));
function chain(table: string) {
  const filters: Array<[string, unknown, "eq" | "is" | "in"]> = [];
  let head = false;
  const rows = () => (state.rows[table] ?? [])
    .filter((r) => filters.every(([k, v, how]) => (how === "is" ? (r[k] ?? null) === v : how === "in" ? (v as unknown[]).includes(r[k]) : r[k] === v)))
    .map((r) => ({ ...r }));
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => {
        // postgrest-js on a HEAD request: PostgREST's 404 for a missing table
        // has no body, and processResponse maps a body-less 404 to status 204
        // with error = null — a HEAD can never see PGRST205 / 42P01.
        if (head && state.errors[table] && /PGRST205|42P01/.test(state.errors[table].code ?? "")) return resolve({ data: null, error: null, count: null, status: 204 });
        if (state.errors[table]) return resolve({ data: null, error: state.errors[table] });
        if (head) return resolve({ data: null, error: null, count: rows().length });
        return resolve({ data: rows(), error: null, count: rows().length });
      };
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        // the ledger's slot rows land, so a later sign-off's update finds them
        if (prop === "insert" && table === "ticket_review_slots" && !state.errors[table]) {
          state.rows[table] = [...(state.rows[table] ?? []), ...(Array.isArray(args[0]) ? args[0] : [args[0]]) as Array<Record<string, unknown>>];
        }
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
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) }, __registerScopedServerClient: () => {} }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn((fn: () => unknown) => { state.after.push(fn); }) }));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "b",
  r2: {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: { Key: string } }) => {
      const kind = cmd.constructor.name;
      state.r2.push({ kind, key: cmd.input.Key });
      if (kind === "GetObjectCommand") {
        if (state.r2Hang) return new Promise(() => {});
        if (state.r2Fail) throw new Error("timeout");
        return { ContentLength: BYTES.length, Body: (async function* () { yield new TextEncoder().encode(BYTES); })() };
      }
      return { ContentLength: 4096, ETag: '"e"' };
    }),
  },
}));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => ({ ok: true })) }));
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";
import { HASH_LIMITS } from "@/lib/ticketRoster";
import { PRODUCER_FLOOR_REASON } from "@/lib/workflow";
const LIMITS0 = { ...HASH_LIMITS };

const post = (body: unknown) => workflowAction(new NextRequest("http://x/api/tickets/workflow-action", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const member = (uid: string, role: string, roles = [role]) => ({ org_id: "o1", uid, role, roles, email: `${uid}@x.io`, display_name: uid, status: "active" });
const DRAFT = { id: "a-d", name: "iso_1A.pdf", url: "orgs/o1/tickets/REQ-1/iso_1A.pdf", type: "Draft", status: "staged" } as TicketAttachment;
const ROUTING = { slots: [
  { kind: "accept", label: "Requester acceptance", mode: "blocking", fill: { identity: "requester" } },
  // filled by the engineering capability: this table carries the org's
  // engineering gate itself (DF-P5 fix pass 2 — a table that does not gets
  // the seed's engineering slot appended)
  { kind: "check", label: "Engineering check", mode: "blocking", fill: { capability: "ticket.final_approve" }, independent_of: ["drafter"] },
] };
const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "x", status: "DRAFTING", request_type: "ISO", unit: null,
  requester_id: "req-1", requester_role: "Requester", assigned_drafter_id: "d-1", assigned_engineer_id: null,
  attachments: [DRAFT], comments: [], history: [], watchers: [], unread_by: [], revision_count: 0, draft_iteration: 0,
  last_modified: LM, library_id: LIB, metadata: {}, ...over,
});
const seed = (lib: Record<string, unknown> | null = { routing_control: ROUTING }) => {
  state.rows.org_members = [member("req-1", "Requester"), member("d-1", "Drafter"), member("e-1", "Engineer-2"), member("e-2", "Engineer-3"), member("a-1", "Admin")];
  state.rows.libraries = lib ? [{ id: LIB, org_id: "o1", name: "P&IDs", ...lib }] : [];
  state.rows.ticket_review_slots = [];
};
const updates = () => state.calls.filter((c) => c.table === "tickets" && c.method === "update").map((c) => c.args[0] as Record<string, unknown>);
const audits = () => state.calls.filter((c) => c.table === "audit_logs" && c.method === "insert").map((c) => c.args[0] as { action: string; details: Record<string, unknown> });
const ledger = () => state.calls.filter((c) => c.table.startsWith("ticket_review_slot") && (c.method === "insert" || c.method === "update"));

/** Run what the route scheduled after its response (next/server after()). */
async function runAfter(): Promise<void> {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  const fns = state.after.splice(0);
  await Promise.allSettled(fns.map((f) => Promise.resolve().then(f)));
  vi.unstubAllGlobals();
}
const hashedRow = (action: string) => audits().find((x) => x.action === `${action}_FILES_HASHED`);

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.errors = {}; state.r2 = []; state.r2Fail = false; state.r2Hang = false; state.after = [];
  Object.assign(HASH_LIMITS, LIMITS0);
});

/** Submit as the drafter and return the roster the route wrote. */
async function submitRouted(over: Record<string, unknown> = {}): Promise<TicketReviewRoster> {
  state.user = { id: "d-1" };
  state.rows.tickets = [ticketRow(over)];
  const res = await post({ ticketId: "t1", actionType: "submit_draft" });
  expect(res.status).toBe(200);
  return (updates()[0].metadata as { review_roster: TicketReviewRoster }).review_roster;
}

describe("REGRESSION — an unconfigured ticket submits, gates and notifies exactly as today", () => {
  it("no library: submit_draft lands at PENDING_REVIEW with no routing read, no hash, no ledger, no metadata", async () => {
    seed();
    state.user = { id: "d-1" };
    state.rows.tickets = [ticketRow({ library_id: null })];
    const res = await post({ ticketId: "t1", actionType: "submit_draft" });
    expect(res.status).toBe(200);
    const u = updates()[0];
    expect(u.status).toBe("PENDING_REVIEW");
    expect("metadata" in u).toBe(false);
    expect(state.calls.some((c) => c.table === "libraries")).toBe(false);
    expect(state.r2.filter((x) => x.kind === "GetObjectCommand")).toEqual([]);
    expect(ledger()).toEqual([]);
  });
  it("a library with no routing table anywhere: today's path (the chain is read, nothing else)", async () => {
    seed({ routing_control: null });
    state.user = { id: "d-1" };
    state.rows.tickets = [ticketRow()];
    const res = await post({ ticketId: "t1", actionType: "submit_draft" });
    expect(res.status).toBe(200);
    expect("metadata" in updates()[0]).toBe(false);
    expect(ledger()).toEqual([]);
    expect(state.r2.filter((x) => x.kind === "GetObjectCommand")).toEqual([]);
  });
  it("before 20261241 (routing_control missing: 42703) — today's path, not a refusal", async () => {
    seed();
    state.errors.libraries = { code: "42703", message: "column libraries.routing_control does not exist" };
    state.user = { id: "d-1" };
    state.rows.tickets = [ticketRow()];
    const res = await post({ ticketId: "t1", actionType: "submit_draft" });
    expect(res.status).toBe(200);
    expect("metadata" in updates()[0]).toBe(false);
  });
  it("before 20261242 (the ledger missing: PGRST205) — submitted the usual way, and the answer says so", async () => {
    seed();
    state.errors.ticket_review_slots = { code: "PGRST205", message: "Could not find the table 'public.ticket_review_slots' in the schema cache" };
    state.user = { id: "d-1" };
    state.rows.tickets = [ticketRow()];
    const res = await post({ ticketId: "t1", actionType: "submit_draft" });
    expect(res.status).toBe(200);
    expect("metadata" in updates()[0]).toBe(false);
    expect((await res.json()).warning).toMatch(/20261242 is not applied/);
    // the probe is a GET (a HEAD could not see the missing table — the
    // harness reproduces postgrest-js's HEAD behaviour), and nothing is
    // written to the ledger that is not there
    const probe = state.calls.filter((c) => c.table === "ticket_review_slots" && c.method === "select");
    expect(probe.length).toBeGreaterThan(0);
    expect(probe.every((c) => !(c.args[1] as { head?: boolean } | undefined)?.head)).toBe(true);
    expect(ledger()).toEqual([]);
  });
});

describe("GAP-103 — a routed library opens a parallel roster on submission", () => {
  it("the roster rides the ticket's compare-and-set; the ledger records every slot; the audit row names the roster and its content hash", async () => {
    seed();
    const roster = await submitRouted();
    expect(updates()[0].status).toBe("PENDING_REVIEW");
    expect(roster.slots.map((s) => [s.kind, s.status, s.primaries])).toEqual([["accept", "open", ["req-1"]], ["check", "open", ["e-1", "e-2"]]]);
    expect(roster.files).toEqual([{ id: "a-d", name: "iso_1A.pdf", url: DRAFT.url, sha256: SHA }]);
    expect(state.r2.filter((x) => x.kind === "GetObjectCommand").map((x) => x.key)).toEqual([DRAFT.url]);
    const a = audits().find((x) => x.action === "TICKET_SUBMIT_DRAFT")!;
    expect(a.details.reviewRoster).toMatchObject({ id: roster.id, event: "opened", contentHash: roster.contentHash });
    const l = ledger();
    expect(l.map((x) => `${x.table}:${x.method}`)).toEqual(["ticket_review_slots:insert", "ticket_review_slot_events:insert"]);
    // every slot's people are told (they join the unread set)
    expect(updates()[0].unread_by).toEqual(expect.arrayContaining(["req-1", "e-1", "e-2"]));
    // the audit row was written before the ticket write
    const order = state.calls.filter((c) => (c.table === "audit_logs" && c.method === "insert") || (c.table === "tickets" && c.method === "update")).map((c) => c.table);
    expect(order[0]).toBe("audit_logs");
  });
  it("DEC-36 fail closed: a chain that cannot be read refuses the submission (503), nothing written", async () => {
    seed();
    state.errors.libraries = { code: "08006", message: "connection lost" };
    state.user = { id: "d-1" };
    state.rows.tickets = [ticketRow()];
    const res = await post({ ticketId: "t1", actionType: "submit_draft" });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("routing_unreadable");
    expect(updates()).toEqual([]);
    expect(audits()).toEqual([]);
  });
  it("a routing table that cannot be used refuses with the reason (409), nothing written — never a silent drop to 'no review'", async () => {
    seed({ routing_control: { slots: [{ kind: "x", mode: "notify_only", fill: { roles: ["Engineer"] } }] } });
    state.user = { id: "d-1" };
    state.rows.tickets = [ticketRow()];
    const res = await post({ ticketId: "t1", actionType: "submit_draft" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "routing_invalid" });
    expect(updates()).toEqual([]);
  });
  it("files storage cannot read refuse the submission (503 content_unhashable): a roster never opens without its binding", async () => {
    seed();
    state.r2Fail = true;
    state.user = { id: "d-1" };
    state.rows.tickets = [ticketRow()];
    const res = await post({ ticketId: "t1", actionType: "submit_draft" });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("content_unhashable");
    expect(updates()).toEqual([]);
  });
});

describe("GAP-103 / TIER-5 / EVID-12 — sign-offs", () => {
  const underReview = (roster: TicketReviewRoster) => ticketRow({
    status: "PENDING_REVIEW", deliverable_rev: "1A", draft_iteration: 1,
    attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }], metadata: { review_roster: roster },
  });
  const signature = (id: string, signer: string, hash: string) => ({
    id, org_id: "o1", resource_type: "ticket", resource_id: "t1", signer_user_id: signer, content_hash: hash, intent: "Reviewed", signed_at: "2099-01-01T00:00:00Z",
  });

  it("a sign-off needs the signer's own e-signature on this ticket, bound to the roster's hash; anything else is refused with nothing written", async () => {
    seed();
    const roster = await submitRouted();
    state.calls = [];
    state.rows.tickets = [underReview(roster)];
    state.user = { id: "e-1" };
    expect((await post({ ticketId: "t1", actionType: "sign_slot" })).status).toBe(400);
    state.rows.e_signatures = [signature(SIG, "e-1", "not-the-hash")];
    const wrong = await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG });
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).error).toMatch(/not the files under review/);
    state.rows.e_signatures = [signature(SIG, "e-2", roster.contentHash)];
    expect((await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG })).status).toBe(403);
    expect(updates()).toEqual([]);
  });

  it("TIER-5: the first sign-off keeps the status (one wait); the second — in either order — issues the ticket automatically", async () => {
    seed();
    const roster = await submitRouted();
    // the engineer signs first
    state.calls = [];
    state.rows.tickets = [underReview(roster)];
    state.rows.e_signatures = [signature(SIG, "e-1", roster.contentHash)];
    state.user = { id: "e-1" };
    const first = await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG });
    expect(first.status).toBe(200);
    expect(updates()[0].status).toBeUndefined();
    const after = (updates()[0].metadata as { review_roster: TicketReviewRoster }).review_roster;
    expect(after.slots.find((s) => s.kind === "check")).toMatchObject({ status: "satisfied", satisfiedBy: "e-1", signatureId: SIG, via: "primary" });
    expect(ledger().map((x) => `${x.table}:${x.method}`)).toEqual(["ticket_review_slots:update", "ticket_review_slot_events:insert"]);
    expect(audits().find((x) => x.action === "TICKET_SIGN_SLOT")?.details.reviewRoster).toMatchObject({ event: "signed", complete: false, signatureId: SIG });
    // then the requester — the last blocking slot issues it
    state.calls = [];
    state.rows.tickets = [underReview(after)];
    state.rows.e_signatures = [signature(SIG2, "req-1", roster.contentHash)];
    state.user = { id: "req-1" };
    const second = await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG2 });
    expect(second.status).toBe(200);
    expect(updates()[0]).toMatchObject({ status: "PENDING_IFC", deliverable_rev: "1" });
    expect(((updates()[0].metadata as { review_roster: TicketReviewRoster }).review_roster).closedReason).toBe("complete");
  });

  it("DEC-37: the drafter occupying a slot independent of the drafter is refused with the constraint named (orgs of 3+)", async () => {
    seed({ routing_control: { slots: [{ kind: "check", label: "Engineering check", mode: "blocking", fill: { roles: ["Drafter", "Engineer"] }, independent_of: ["drafter"] }] } });
    const roster = await submitRouted();
    state.calls = [];
    state.rows.tickets = [underReview(roster)];
    state.rows.e_signatures = [signature(SIG, "d-1", roster.contentHash)];
    state.user = { id: "d-1" };
    const res = await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/"Engineering check" must be independent of the drafter/);
    expect(updates()).toEqual([]);
  });

  it("a revision request closes the roster: its open slots are void on the ticket and in the ledger", async () => {
    seed();
    const roster = await submitRouted();
    state.calls = [];
    state.rows.tickets = [underReview(roster)];
    state.user = { id: "e-1" };
    const res = await post({ ticketId: "t1", actionType: "request_revision", comment: "fix the tag" });
    expect(res.status).toBe(200);
    const closed = (updates()[0].metadata as { review_roster: TicketReviewRoster }).review_roster;
    expect(closed.slots.every((s) => s.status === "void")).toBe(true);
    expect(ledger().filter((x) => x.method === "update")).toHaveLength(2);
  });
});

describe("EVID-12 / FRIC-5 — today's approvals carry the server's sha256; issue-as-is when the drafter marked it", () => {
  const legacy = (over: Record<string, unknown> = {}) => ticketRow({
    status: "PENDING_REVIEW", deliverable_rev: "1A", draft_iteration: 1, library_id: null, requester_role: "Engineer-2",
    attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }], ...over,
  });
  it("approve_draft_ifc: today's path reads NO storage before answering (fix pass 2); the approval row names the files as before and points at the follow-up row, which carries the sha256 computed from the bytes after the response", async () => {
    seed();
    state.rows.org_members[0] = member("req-1", "Engineer-2");
    state.rows.tickets = [legacy()];
    state.user = { id: "req-1" };
    const res = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(res.status).toBe(200);
    expect(updates()[0].status).toBe("PENDING_IFC");
    expect(state.r2.filter((x) => x.kind === "GetObjectCommand")).toEqual([]);
    const a = audits().find((x) => x.action === "TICKET_APPROVE_DRAFT_IFC")! as { action: string; details: Record<string, unknown>; id?: string };
    expect((a.details.approvedDrafts as Array<Record<string, unknown>>)[0]).toEqual({ id: "a-d", name: "iso_1A.pdf", url: DRAFT.url, size: null, etag: null });
    expect(a.details.filesHashedIn).toBe("TICKET_APPROVE_DRAFT_IFC_FILES_HASHED");
    expect(hashedRow("TICKET_APPROVE_DRAFT_IFC")).toBeUndefined();
    await runAfter();
    const f = hashedRow("TICKET_APPROVE_DRAFT_IFC")! as { details: Record<string, unknown> };
    expect(f.details.approval).toBe(a.id);
    expect((f.details.approvedDrafts as Array<{ sha256: string }>)[0].sha256).toBe(SHA);
  });
  it("storage that cannot answer never touches the approval (today's flow): the follow-up row says the hash was unavailable", async () => {
    seed();
    state.r2Fail = true;
    state.rows.org_members[0] = member("req-1", "Engineer-2");
    state.rows.tickets = [legacy()];
    state.user = { id: "req-1" };
    const res = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(res.status).toBe(200);
    await runAfter();
    const f = hashedRow("TICKET_APPROVE_DRAFT_IFC")!;
    expect((f.details.approvedDrafts as Array<Record<string, unknown>>)[0]).toMatchObject({ sha256: null, sha256Unavailable: "storage could not be read" });
  });
  it("FRIC-5: the drafter marks issue-ready; the approval then issues the draft as the Final (FINAL_DRAFT) — no second drafter step", async () => {
    seed();
    state.rows.org_members[0] = member("req-1", "Engineer-2");
    state.rows.tickets = [legacy()];
    state.user = { id: "d-1" };
    expect((await post({ ticketId: "t1", actionType: "mark_issue_ready" })).status).toBe(200);
    const meta = updates()[0].metadata as Record<string, unknown>;
    expect(meta.issue_ready).toMatchObject({ rev: "1A", by: "d-1" });
    state.calls = [];
    state.rows.tickets = [legacy({ metadata: meta })];
    state.user = { id: "req-1" };
    const res = await post({ ticketId: "t1", actionType: "approve_draft_ifc", issueAsIsAcknowledged: true });
    expect(res.status).toBe(200);
    const u = updates()[0];
    expect(u.status).toBe("FINAL_DRAFT");
    expect((u.attachments as TicketAttachment[]).filter((x) => x.type === "Final")).toEqual([expect.objectContaining({ url: DRAFT.url, rev: "1", issuedFromDraftId: "a-d" })]);
  });
  it("DF-P5 fix pass 2 (UI-4): the mark is not a status change — the reviewer gets ONE bell row (no email), the watchers are not told, nobody's outstanding review alert is superseded, every unread marker is kept", async () => {
    seed();
    state.rows.org_members[0] = member("req-1", "Engineer-2");
    state.rows.org_members.push(member("w-1", "Viewer"));
    state.rows.tickets = [legacy({ watchers: ["w-1"], unread_by: ["x-1"] })];
    state.rows.notifications = [{ id: "n-1", resource_id: "t1", org_id: "o1", read_at: null, metadata: { action: "submit_draft" } }];
    state.user = { id: "d-1" };
    expect((await post({ ticketId: "t1", actionType: "mark_issue_ready" })).status).toBe(200);
    expect((updates()[0].unread_by as string[]).sort()).toEqual(["req-1", "x-1"]);
    const bells = state.calls.filter((c) => c.table === "notifications" && c.method === "insert").flatMap((c) => c.args[0] as Array<{ userId?: string; user_id?: string; title: string; metadata: Record<string, unknown> }>);
    expect(bells.map((b) => b.user_id ?? b.userId)).toEqual(["req-1"]);
    expect(bells[0].title).toMatch(/^Marked issue-ready · /);
    expect(bells[0].metadata).toMatchObject({ activity: "mark_issue_ready" });
    expect(bells[0].metadata.action).toBeUndefined();
    expect(state.calls.filter((c) => c.table === "email_notifications")).toEqual([]);
    expect(state.calls.filter((c) => c.table === "notifications" && c.method === "update")).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DF-P5 fix pass
describe("DF-P5 fix — hashing never blocks or meaningfully slows a legacy approval (bounded: one deadline, one byte budget)", () => {
  const legacy = (over: Record<string, unknown> = {}) => ticketRow({
    status: "PENDING_REVIEW", deliverable_rev: "1A", draft_iteration: 1, library_id: null, requester_role: "Engineer-2",
    attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }], ...over,
  });
  it("a GetObject that NEVER answers: the approval lands without waiting on it at all; the follow-up row (after the response, bounded) says 'not hashed (deadline)'", async () => {
    HASH_LIMITS.legacyDeadlineMs = 60;
    seed();
    state.r2Hang = true;
    state.rows.org_members[0] = member("req-1", "Engineer-2");
    state.rows.tickets = [legacy()];
    state.user = { id: "req-1" };
    const t0 = Date.now();
    const res = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(res.status).toBe(200);
    expect(updates()[0].status).toBe("PENDING_IFC");
    expect(state.r2.filter((x) => x.kind === "GetObjectCommand")).toEqual([]);
    await runAfter();
    const f = hashedRow("TICKET_APPROVE_DRAFT_IFC")!;
    expect((f.details.approvedDrafts as Array<Record<string, unknown>>)[0]).toMatchObject({ sha256: null, sha256Unavailable: "not hashed (deadline)" });
  });
  it("only the Drafts of the revision being approved are read — earlier rounds' Drafts are named, not downloaded", async () => {
    seed();
    state.rows.org_members[0] = member("req-1", "Engineer-2");
    const old = Array.from({ length: 12 }, (_, i) => ({ ...DRAFT, id: `old-${i}`, url: `orgs/o1/tickets/REQ-1/old_${i}.pdf`, status: "submitted", rev: "1A" }));
    state.rows.tickets = [legacy({ deliverable_rev: "1B", draft_iteration: 2, attachments: [...old, { ...DRAFT, id: "cur", status: "submitted", rev: "1B" }] })];
    state.user = { id: "req-1" };
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(200);
    await runAfter();
    expect(state.r2.filter((x) => x.kind === "GetObjectCommand").map((x) => x.key)).toEqual([DRAFT.url]);
    const drafts = hashedRow("TICKET_APPROVE_DRAFT_IFC")!.details.approvedDrafts as Array<Record<string, unknown>>;
    expect(drafts.find((d) => d.id === "cur")).toMatchObject({ sha256: SHA });
    expect(drafts.find((d) => d.id === "old-0")).toMatchObject({ sha256: null, sha256Unavailable: "not hashed (not the revision being approved)" });
  });
  it("a routed submission whose storage never answers is refused at the roster deadline (503, nothing written) — never hung", async () => {
    HASH_LIMITS.rosterDeadlineMs = 60;
    seed();
    state.r2Hang = true;
    state.user = { id: "d-1" };
    state.rows.tickets = [ticketRow()];
    const t0 = Date.now();
    const res = await post({ ticketId: "t1", actionType: "submit_draft" });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("content_unhashable");
    expect(updates()).toEqual([]);
  });
});

describe("DF-P5 fix — reopen_ticket never opens a roster (TIER-5: routed review is a superset of today's flows)", () => {
  it("REGRESSION: reopening a closed ticket in a routed library with NO Draft lands at PENDING_REVIEW on today's path — no refusal, no storage read, no roster", async () => {
    seed();
    state.user = { id: "a-1" };
    state.rows.tickets = [ticketRow({ status: "CLOSED", attachments: [], deliverable_rev: "1" })];
    const res = await post({ ticketId: "t1", actionType: "reopen_ticket", comment: "re-run the revision" });
    expect(res.status).toBe(200);
    const u = updates()[0];
    expect(u.status).toBe("PENDING_REVIEW");
    expect((u.metadata as Record<string, unknown> | undefined)?.review_roster).toBeUndefined();
    expect(state.r2.filter((x) => x.kind === "GetObjectCommand")).toEqual([]);
    expect(ledger()).toEqual([]);
  });
  it("with an issued Draft on file the reopen still opens nothing — the next submission binds the roster to its new files", async () => {
    seed();
    state.user = { id: "a-1" };
    state.rows.tickets = [ticketRow({ status: "CLOSED", attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }], deliverable_rev: "1" })];
    expect((await post({ ticketId: "t1", actionType: "reopen_ticket", comment: "again" })).status).toBe(200);
    expect((updates()[0].metadata as Record<string, unknown> | undefined)?.review_roster).toBeUndefined();
    expect(state.r2.filter((x) => x.kind === "GetObjectCommand")).toEqual([]);
  });
});

describe("DF-P5 fix — DEC-37 acceptance 2: the drafter cannot accept their own deliverable on a roster, whatever the table declares", () => {
  it("a table with no independent_of: the drafter's sign-off is refused (403, the floor named), nothing written; an engineer's issues it", async () => {
    seed({ routing_control: { slots: [{ kind: "check", label: "Engineering check", mode: "blocking", fill: { roles: ["Drafter", "Engineer"] } }] } });
    // an engineer requester: the engineering gate does not apply, so the
    // table's one slot is the whole review (fix pass 2 appends nothing)
    state.rows.org_members[0] = member("req-1", "Engineer-2");
    const roster = await submitRouted({ requester_role: "Engineer-2" });
    expect(roster.slots.map((s) => s.kind)).toEqual(["check"]);
    const under = ticketRow({ requester_role: "Engineer-2", status: "PENDING_REVIEW", deliverable_rev: "1A", draft_iteration: 1, attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }], metadata: { review_roster: roster } });
    const sig = (signer: string) => ({ id: SIG, org_id: "o1", resource_type: "ticket", resource_id: "t1", signer_user_id: signer, content_hash: roster.contentHash, intent: "Reviewed", signed_at: "2099-01-01T00:00:00Z" });
    state.calls = [];
    state.rows.tickets = [under];
    state.rows.e_signatures = [sig("d-1")];
    state.user = { id: "d-1" };
    const res = await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(PRODUCER_FLOOR_REASON);
    expect(updates()).toEqual([]);
    state.rows.e_signatures = [sig("e-1")];
    state.user = { id: "e-1" };
    expect((await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG })).status).toBe(200);
    expect(updates()[0]).toMatchObject({ status: "PENDING_IFC" });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DF-P5 fix pass 2
describe("DF-P5 fix pass 2 — a routing table adds reviewers; it never drops the org-wide engineering gate (DEC-13 / DEC-16 / DEC-36)", () => {
  const REQUESTER_ONLY = { slots: [{ kind: "accept", label: "Requester acceptance", mode: "blocking", fill: { identity: "requester" } }] };
  const sig = (id: string, signer: string, hash: string) => ({ id, org_id: "o1", resource_type: "ticket", resource_id: "t1", signer_user_id: signer, content_hash: hash, intent: "Reviewed", signed_at: "2099-01-01T00:00:00Z" });
  const under = (roster: TicketReviewRoster, over: Record<string, unknown> = {}) => ticketRow({
    status: "PENDING_REVIEW", deliverable_rev: "1A", draft_iteration: 1, attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }], metadata: { review_roster: roster }, ...over,
  });

  it("the reviewer's scenario: a Planner-tier requester, a requester-only table — the seed's engineering slot is appended, said on the roster, the history and the audit row; the requester's sign-off alone does NOT issue; the engineer's does, with engineer_approved_at", async () => {
    seed({ routing_control: REQUESTER_ONLY });
    const roster = await submitRouted();
    expect(roster.engineeringGateAdded).toBe(true);
    expect(roster.slots.map((s) => s.kind)).toEqual(["accept", "engineering"]);
    const eng = roster.slots[1];
    expect(eng).toMatchObject({ mode: "blocking", primaries: ["e-1", "e-2"], independentOf: ["drafter"], engineering: true, status: "open" });
    expect(eng.overriders).toContain("a-1");
    expect(audits().find((x) => x.action === "TICKET_SUBMIT_DRAFT")!.details.reviewRoster).toMatchObject({ engineeringGateAdded: true });
    expect(JSON.stringify(updates()[0].history)).toMatch(/Engineering sign-off added/);
    // the requester signs their slot: the review still waits on the engineer
    state.calls = [];
    state.rows.tickets = [under(roster)];
    state.rows.e_signatures = [sig(SIG, "req-1", roster.contentHash)];
    state.user = { id: "req-1" };
    expect((await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG })).status).toBe(200);
    expect(updates()[0].status).toBeUndefined();
    const afterReq = (updates()[0].metadata as { review_roster: TicketReviewRoster }).review_roster;
    // the engineer's sign-off is the last one: issued, and engineering approval recorded
    state.calls = [];
    state.rows.tickets = [under(afterReq)];
    state.rows.e_signatures = [sig(SIG2, "e-1", roster.contentHash)];
    state.user = { id: "e-1" };
    expect((await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG2 })).status).toBe(200);
    expect(updates()[0]).toMatchObject({ status: "PENDING_IFC", deliverable_rev: "1" });
    expect(typeof updates()[0].engineer_approved_at).toBe("string");
  });

  it("an assigned engineer is named on the appended slot", async () => {
    seed({ routing_control: REQUESTER_ONLY });
    const roster = await submitRouted({ assigned_engineer_id: "e-2" });
    expect(roster.slots.find((s) => s.kind === "engineering")?.primaries).toContain("e-2");
  });

  it("an exempt requester (an Engineer tier): the gate does not apply, nothing is appended (the table is the whole review)", async () => {
    seed({ routing_control: REQUESTER_ONLY });
    state.rows.org_members[0] = member("req-1", "Engineer-2");
    const roster = await submitRouted({ requester_role: "Engineer-2" });
    expect(roster.slots.map((s) => s.kind)).toEqual(["accept"]);
    expect(roster.engineeringGateAdded).toBeUndefined();
  });

  it("an engineering-first type keeps an engineer on the roster even for an exempt requester", async () => {
    seed({ routing_control: REQUESTER_ONLY });
    state.rows.org_members[0] = member("req-1", "Engineer-2");
    state.rows.org_configurations = [{ org_id: "o1", key: "drafting", data: { requestTypes: { options: [{ value: "ISO", engineeringFirst: true }] } } }];
    const roster = await submitRouted({ requester_role: "Engineer-2", engineer_review_requested_at: LM });
    expect(roster.slots.map((s) => s.kind)).toEqual(["accept", "engineering"]);
  });

  it("a table whose engineering slot is a ROLE-named slot (the facility's own word, never guessed): the gate slot is still appended, and one engineer's ONE sign-off fills both (DEC-37)", async () => {
    seed({ routing_control: { slots: [{ kind: "check", label: "Discipline check", mode: "blocking", fill: { roles: ["Engineer"] } }] } });
    const roster = await submitRouted();
    expect(roster.slots.map((s) => s.kind)).toEqual(["check", "engineering"]);
    state.calls = [];
    state.rows.tickets = [under(roster)];
    state.rows.e_signatures = [sig(SIG, "e-1", roster.contentHash)];
    state.user = { id: "e-1" };
    expect((await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG })).status).toBe(200);
    expect(updates()[0].status).toBe("PENDING_IFC");
  });
});

describe("DF-P5 fix pass 2 — the ledger probe, a package too large to fingerprint, the completing sign-off's audit row and notice, an unreadable chain", () => {
  const sig = (id: string, signer: string, hash: string) => ({ id, org_id: "o1", resource_type: "ticket", resource_id: "t1", signer_user_id: signer, content_hash: hash, intent: "Reviewed", signed_at: "2099-01-01T00:00:00Z" });
  const under = (roster: TicketReviewRoster, over: Record<string, unknown> = {}) => ticketRow({
    status: "PENDING_REVIEW", deliverable_rev: "1A", draft_iteration: 1, attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }], metadata: { review_roster: roster }, ...over,
  });

  it("a routed package over the request's byte budget is NOT refused (re-uploading could never help): the roster opens, the file bound by identity with the reason, named in the audit row", async () => {
    HASH_LIMITS.rosterByteBudget = 4;
    seed();
    const roster = await submitRouted({ attachments: [{ ...DRAFT, size: 240 * 1024 * 1024 }] });
    expect(roster.files).toEqual([{ id: "a-d", name: "iso_1A.pdf", url: DRAFT.url, sha256: null, size: 240 * 1024 * 1024, unhashed: "not hashed (byte budget)" }]);
    const opened = audits().find((x) => x.action === "TICKET_SUBMIT_DRAFT")!.details.reviewRoster as { files: unknown[] };
    expect(opened.files).toEqual(roster.files);
    // and a sign-off bound to that roster's hash is accepted
    state.calls = [];
    state.rows.tickets = [under(roster)];
    state.rows.e_signatures = [sig(SIG, "e-1", roster.contentHash)];
    state.user = { id: "e-1" };
    expect((await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG })).status).toBe(200);
  });

  it("a file that is not in storage still refuses — with what to do (replace it), never 'upload it again' for a size the request cannot read", async () => {
    seed();
    const { r2 } = await import("@/lib/r2");
    (r2.send as unknown as { mockImplementationOnce: (f: () => unknown) => void }).mockImplementationOnce(async () => { throw Object.assign(new Error("gone"), { name: "NoSuchKey" }); });
    state.user = { id: "d-1" };
    state.rows.tickets = [ticketRow()];
    const res = await post({ ticketId: "t1", actionType: "submit_draft" });
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.code).toBe("content_unhashable");
    expect(j.error).toMatch(/"iso_1A\.pdf" cannot be put under review \(the file is not in storage\) — remove it from the request and attach the file again/);
    expect(updates()).toEqual([]);
  });

  it("EVID-12 done-when 3 on a roster: the COMPLETING sign-off's audit row names what was approved (ids, names, sha256) and, issued as-is, the Final it recorded", async () => {
    seed();
    const roster = await submitRouted();
    const partly = { ...roster, slots: roster.slots.map((s) => (s.kind === "accept" ? { ...s, status: "satisfied" as const, satisfiedBy: "req-1", satisfiedAt: LM, signatureId: SIG2, via: "primary" as const } : s)) };
    state.calls = [];
    state.rows.tickets = [under(partly, { metadata: { review_roster: partly, issue_ready: { rev: "1A", by: "d-1", at: LM } } })];
    state.rows.e_signatures = [sig(SIG, "e-1", roster.contentHash)];
    state.user = { id: "e-1" };
    expect((await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG })).status).toBe(200);
    expect(updates()[0].status).toBe("FINAL_DRAFT");
    const d = audits().find((x) => x.action === "TICKET_SIGN_SLOT")!.details;
    expect(d.approvedDrafts).toEqual([{ id: "a-d", name: "iso_1A.pdf", url: DRAFT.url, sha256: SHA }]);
    expect(d.issuedAsIsFinals).toEqual([expect.objectContaining({ url: DRAFT.url, rev: "1", issuedFromDraftId: "a-d", sha256: SHA })]);
  });

  it("a sign-off that does NOT complete carries no approvedDrafts (it approved nothing yet)", async () => {
    seed();
    const roster = await submitRouted();
    state.calls = [];
    state.rows.tickets = [under(roster)];
    state.rows.e_signatures = [sig(SIG, "e-1", roster.contentHash)];
    state.user = { id: "e-1" };
    expect((await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG })).status).toBe(200);
    expect(audits().find((x) => x.action === "TICKET_SIGN_SLOT")!.details.approvedDrafts).toBeUndefined();
  });

  it("the completing sign-off is notified as an APPROVAL (ticket_approved, 'Review complete — approved'); a partial one as a status change", async () => {
    seed();
    const roster = await submitRouted();
    state.calls = [];
    state.rows.tickets = [under(roster)];
    state.rows.e_signatures = [sig(SIG, "e-1", roster.contentHash)];
    state.user = { id: "e-1" };
    await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG });
    const mails1 = state.calls.filter((c) => c.table === "email_notifications" && c.method === "insert").flatMap((c) => c.args[0] as Array<{ event_type: string }>);
    expect(mails1.length).toBeGreaterThan(0);
    expect(mails1.every((m) => m.event_type === "ticket_status_changed")).toBe(true);
    const after1 = (updates()[0].metadata as { review_roster: TicketReviewRoster }).review_roster;
    state.calls = [];
    state.rows.tickets = [under(after1)];
    state.rows.e_signatures = [sig(SIG2, "req-1", roster.contentHash)];
    state.user = { id: "req-1" };
    await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG2 });
    const mails2 = state.calls.filter((c) => c.table === "email_notifications" && c.method === "insert").flatMap((c) => c.args[0] as Array<{ event_type: string; subject: string }>);
    expect(mails2.length).toBeGreaterThan(0);
    expect(mails2.every((m) => m.event_type === "ticket_approved" && /^Review complete — approved — /.test(m.subject))).toBe(true);
  });

  it("DEC-36: a 42703 naming ANOTHER column on the chain read (a partial restore) refuses the submission — never read as 'no routing'", async () => {
    seed();
    state.errors.libraries = { code: "42703", message: "column collections.path_ids does not exist" };
    state.user = { id: "d-1" };
    state.rows.tickets = [ticketRow()];
    const res = await post({ ticketId: "t1", actionType: "submit_draft" });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("routing_unreadable");
    expect(updates()).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DF-P5 fix pass 3
describe("DF-P5 fix pass 3 — a close out of a review closes its roster for good; a routed review never runs without one", () => {
  const sig = (id: string, signer: string, hash: string) => ({ id, org_id: "o1", resource_type: "ticket", resource_id: "t1", signer_user_id: signer, content_hash: hash, intent: "Reviewed", signed_at: "2099-01-01T00:00:00Z" });
  const under = (roster: TicketReviewRoster, over: Record<string, unknown> = {}) => ticketRow({
    status: "PENDING_REVIEW", deliverable_rev: "1A", draft_iteration: 1, attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }], metadata: { review_roster: roster }, ...over,
  });

  it("major 1: a FORCE CLOSE of a routed ticket under review stores the roster CLOSED (closedAt, open slots void) beside the deliverable note — and after reopen_ticket no roster is current", async () => {
    const { currentRoster } = await import("@/lib/workflow");
    seed();
    const roster = await submitRouted();
    // the engineer signs; the requester's slot is still open
    state.calls = [];
    state.rows.tickets = [under(roster)];
    state.rows.e_signatures = [sig(SIG, "e-1", roster.contentHash)];
    state.user = { id: "e-1" };
    expect((await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG })).status).toBe(200);
    const signed = (updates()[0].metadata as { review_roster: TicketReviewRoster }).review_roster;
    // the Admin force-closes it
    state.calls = [];
    state.rows.tickets = [under(signed)];
    state.user = { id: "a-1" };
    const closeRes = await post({ ticketId: "t1", actionType: "close_ticket", comment: "abandoned" });
    expect(closeRes.status).toBe(200);
    const closedMeta = updates()[0].metadata as Record<string, unknown> & { review_roster: TicketReviewRoster };
    expect(updates()[0].status).toBe("CLOSED");
    // the deliverable note is still written (the library-less-of-document branch)…
    expect(closedMeta.deliverable).toMatchObject({ state: "not_in_register", library_id: LIB });
    // …ON the transition's metadata: the roster is closed, its open slot void
    expect(closedMeta.review_roster.closedAt).toBeTruthy();
    expect(closedMeta.review_roster.closedReason).toBe("close_ticket");
    expect(closedMeta.review_roster.slots.find((x) => x.kind === "accept")?.status).toBe("void");
    expect(closedMeta.review_roster.slots.find((x) => x.kind === "check")?.status).toBe("satisfied");
    // the requester reopens it: back in PENDING_REVIEW, and the old roster
    // (with its engineering sign-off) does not come back to life
    state.calls = [];
    state.rows.tickets = [ticketRow({ status: "CLOSED", deliverable_rev: "1A", draft_iteration: 1, attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }], metadata: closedMeta })];
    state.user = { id: "req-1" };
    expect((await post({ ticketId: "t1", actionType: "reopen_ticket", comment: "needed after all" })).status).toBe(200);
    const reopened = updates()[0];
    expect(reopened.status).toBe("PENDING_REVIEW");
    const reopenedMeta = (reopened.metadata as Record<string, unknown> | undefined) ?? closedMeta;
    expect(currentRoster({ status: "PENDING_REVIEW", metadata: reopenedMeta } as never)).toBeNull();
  });

  it("major 2: a reopened ticket in a routed library is NOT approved on the serial path — 409 with the way forward, nothing written; the page's engine renders those approvals disabled with the same reason", async () => {
    const { WorkflowEngine, ROUTED_NO_ROSTER_REASON } = await import("@/lib/workflow");
    seed({ routing_control: { slots: [
      { kind: "accept", label: "Requester acceptance", mode: "blocking", fill: { identity: "requester" } },
      { kind: "qa", label: "QA", mode: "blocking", fill: { users: ["e-2"] } },
    ] } });
    // an Engineer-tier requester: the serial path would offer approve_draft_ifc directly
    state.rows.org_members[0] = member("req-1", "Engineer-2");
    const reopened = ticketRow({ status: "PENDING_REVIEW", requester_role: "Engineer-2", revision_count: 1, deliverable_rev: null, attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }] });
    state.rows.tickets = [reopened];
    state.user = { id: "req-1" };
    for (const actionType of ["approve_draft_ifc", "approve_minor_correction"]) {
      state.calls = [];
      const res = await post({ ticketId: "t1", actionType, comment: "ok" });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: ROUTED_NO_ROSTER_REASON, code: "routing_needs_roster" });
      expect(updates()).toEqual([]);
      expect(audits()).toEqual([]);
    }
    // the engine, asked as the page asks it (reviewRouted known), says why
    const { rowToTicket } = await import("@/lib/ticketTransitions");
    const t = rowToTicket(reopened as never);
    const offered = WorkflowEngine.getActions(t, "Engineer-2" as never, "req-1", undefined, { reviewRouted: true, activeMemberCount: 5 });
    expect(offered.find((a) => a.action === "approve_draft_ifc")?.disabledReason).toBe(ROUTED_NO_ROSTER_REASON);
    // a revision stays open — the way forward
    expect(offered.find((a) => a.action === "request_revision")?.disabledReason).toBeUndefined();
    // REGRESSION: an unconfigured workspace's engine answer is unchanged
    const plain = WorkflowEngine.getActions(t, "Engineer-2" as never, "req-1", undefined, { activeMemberCount: 5 });
    expect(plain.find((a) => a.action === "approve_draft_ifc")?.disabledReason).toBeUndefined();
  });

  it("major 2 (route): the route resolves the routing itself for a rosterless approval and refuses with 409 routing_needs_roster", async () => {
    seed();
    state.rows.org_members[0] = member("req-1", "Engineer-2");
    state.rows.tickets = [ticketRow({ status: "PENDING_REVIEW", requester_role: "Engineer-2", deliverable_rev: "1A", draft_iteration: 1, attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }] })];
    state.user = { id: "req-1" };
    const res = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("routing_needs_roster");
    expect(updates()).toEqual([]);
    expect(audits()).toEqual([]);
    // the chain cannot be read: 503, never an unchecked approval
    state.errors.libraries = { code: "XX000", message: "boom" };
    const down = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(down.status).toBe(503);
    expect((await down.json()).code).toBe("routing_unreadable");
    delete state.errors.libraries;
    // before 20261242 (no ledger): the usual review is the review — approved as today
    state.errors.ticket_review_slots = { code: "PGRST205", message: "Could not find the table 'public.ticket_review_slots' in the schema cache" };
    state.calls = [];
    const pre = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(pre.status).toBe(200);
    expect(updates()[0].status).toBe("PENDING_IFC");
  });

  it("REGRESSION: a library with no routing table approves on the serial path exactly as today", async () => {
    seed({ routing_control: null });
    state.rows.org_members[0] = member("req-1", "Engineer-2");
    state.rows.tickets = [ticketRow({ status: "PENDING_REVIEW", requester_role: "Engineer-2", deliverable_rev: "1A", draft_iteration: 1, attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }] })];
    state.user = { id: "req-1" };
    const res = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(res.status).toBe(200);
    expect(updates()[0].status).toBe("PENDING_IFC");
  });

  it("major 3: a PARTIAL sign-off keeps every still-waited-on reviewer unread, tells them, and supersedes only the signer's own alerts", async () => {
    seed({ routing_control: { slots: [
      { kind: "check", label: "Engineering check", mode: "blocking", fill: { users: ["e-1", "e-2"] }, independent_of: ["drafter"] },
      { kind: "qa", label: "QA", mode: "blocking", fill: { users: ["q-1"] } },
    ] } });
    state.rows.org_members.push(member("q-1", "Viewer"));
    const roster = await submitRouted();
    expect((updates()[0].unread_by as string[])).toContain("q-1");
    state.calls = [];
    state.rows.tickets = [under(roster, { unread_by: ["req-1", "e-1", "e-2", "q-1"] })];
    state.rows.notifications = [
      { id: "n-q", user_id: "q-1", resource_id: "t1", org_id: "o1", read_at: null, metadata: { action: "submit_draft" } },
      { id: "n-e1", user_id: "e-1", resource_id: "t1", org_id: "o1", read_at: null, metadata: { action: "submit_draft" } },
      // fix pass 4: e-2 fills the slot e-1 is about to satisfy
      { id: "n-e2", user_id: "e-2", resource_id: "t1", org_id: "o1", read_at: null, metadata: { action: "submit_draft" } },
      // fix pass 4: an earlier partial sign-off's notice to Q (replaced by this one's)
      { id: "n-q-old", user_id: "q-1", resource_id: "t1", org_id: "o1", read_at: null, metadata: { action: "sign_slot" } },
      // someone with no part here is never touched by a partial sign-off
      { id: "n-x", user_id: "x-9", resource_id: "t1", org_id: "o1", read_at: null, metadata: { action: "submit_draft" } },
    ];
    state.rows.e_signatures = [sig(SIG, "e-1", roster.contentHash)];
    state.user = { id: "e-1" };
    expect((await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG })).status).toBe(200);
    const u = updates()[0];
    expect(u.status).toBeUndefined();
    // Q's slot is still open: Q keeps the marker; the signer is cleared
    expect(u.unread_by as string[]).toContain("q-1");
    expect(u.unread_by as string[]).not.toContain("e-1");
    // fix pass 4: e-2's slot is satisfied — nothing waits on e-2 any more
    expect(u.unread_by as string[]).not.toContain("e-2");
    expect(u.unread_by as string[]).toContain("req-1"); // today's participant, kept
    // the signer's and e-2's alerts are retired, and Q's earlier sign-off
    // notice; Q's "review opened" alert stays live, x-9's is untouched
    const updatedIds = state.calls.filter((c) => c.table === "notifications" && c.method === "eq" && c.args[0] === "id").map((c) => c.args[1]);
    expect(updatedIds.sort()).toEqual(["n-e1", "n-e2", "n-q-old"]);
    const supersedeIn = state.calls.filter((c) => c.table === "notifications" && c.method === "in" && c.args[0] === "user_id").map((c) => [...(c.args[1] as string[])].sort());
    // read: the signer and the released co-occupant (every alert), and the
    // people this sign-off tells again (their earlier sign_slot notice only)
    expect(supersedeIn).toEqual([["d-1", "e-1", "e-2", "q-1", "req-1"]]);
    // and Q is told of the sign-off; e-2 is not
    const bells = state.calls.filter((c) => c.table === "notifications" && c.method === "insert").flatMap((c) => c.args[0] as Array<{ user_id?: string; userId?: string }>);
    expect(bells.map((b) => b.user_id ?? b.userId)).toContain("q-1");
    expect(bells.map((b) => b.user_id ?? b.userId)).not.toContain("e-2");
  });

  it("major 3 (REGRESSION): the COMPLETING sign-off still retires every outstanding alert (the ticket moved on)", async () => {
    seed();
    const roster = await submitRouted();
    state.calls = [];
    const half = { ...roster, slots: roster.slots.map((x) => (x.kind === "check" ? { ...x, status: "satisfied" as const, satisfiedBy: "e-1", signatureId: SIG, via: "primary" as const } : x)) };
    state.rows.tickets = [under(half)];
    state.rows.notifications = [
      { id: "n-r", user_id: "req-1", resource_id: "t1", org_id: "o1", read_at: null, metadata: { action: "submit_draft" } },
      { id: "n-x", user_id: "x-9", resource_id: "t1", org_id: "o1", read_at: null, metadata: { action: "submit_draft" } },
    ];
    state.rows.e_signatures = [sig(SIG2, "req-1", roster.contentHash)];
    state.user = { id: "req-1" };
    expect((await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG2 })).status).toBe(200);
    expect(updates()[0].status).toBe("PENDING_IFC");
    expect(state.calls.filter((c) => c.table === "notifications" && c.method === "update")).toHaveLength(2);
  });
});

describe("DF-P5 fix pass 3 — the as-is confirmation is the server's too; a sign-off is checked before its signature is minted", () => {
  const legacy = (over: Record<string, unknown> = {}) => ticketRow({
    status: "PENDING_REVIEW", deliverable_rev: "1A", draft_iteration: 1, library_id: null, requester_role: "Engineer-2",
    attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }], ...over,
  });
  const sig = (id: string, signer: string, hash: string) => ({ id, org_id: "o1", resource_type: "ticket", resource_id: "t1", signer_user_id: signer, content_hash: hash, intent: "Reviewed", signed_at: "2099-01-01T00:00:00Z" });

  it("FRIC-5: an approval of a draft marked issue-as-is WITHOUT the approver's acknowledgement is refused (409), nothing written; with it, issued as-is", async () => {
    seed();
    state.rows.org_members[0] = member("req-1", "Engineer-2");
    state.rows.tickets = [legacy({ metadata: { issue_ready: { rev: "1A", by: "d-1", at: LM } } })];
    state.user = { id: "req-1" };
    const blind = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(blind.status).toBe(409);
    expect((await blind.json()).code).toBe("issue_as_is_unconfirmed");
    expect(updates()).toEqual([]);
    expect(audits()).toEqual([]);
    const ok = await post({ ticketId: "t1", actionType: "approve_draft_ifc", issueAsIsAcknowledged: true });
    expect(ok.status).toBe(200);
    expect(updates()[0].status).toBe("FINAL_DRAFT");
  });
  it("REGRESSION: an unmarked draft needs no acknowledgement; a minor correction (never as-is) needs none either", async () => {
    seed();
    state.rows.org_members[0] = member("req-1", "Engineer-2");
    state.rows.tickets = [legacy()];
    state.user = { id: "req-1" };
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(200);
    state.calls = [];
    state.rows.tickets = [legacy({ metadata: { issue_ready: { rev: "1A", by: "d-1", at: LM } } })];
    expect((await post({ ticketId: "t1", actionType: "approve_minor_correction", comment: "fix the tag" })).status).toBe(200);
  });

  it("TIER-8: a dry run answers whether the sign-off is open to the caller — no signature needed, nothing written; a refused one says why", async () => {
    seed();
    const roster = await submitRouted();
    state.calls = [];
    state.rows.tickets = [ticketRow({ status: "PENDING_REVIEW", deliverable_rev: "1A", draft_iteration: 1, attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }], metadata: { review_roster: roster } })];
    state.user = { id: "e-1" };
    const ok = await post({ ticketId: "t1", actionType: "sign_slot", dryRun: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, dryRun: true, slots: ["Engineering check"] });
    expect(updates()).toEqual([]);
    expect(audits()).toEqual([]);
    expect(ledger()).toEqual([]);
    // a dry run is never an action applied
    const notDry = await post({ ticketId: "t1", actionType: "request_revision", comment: "x", dryRun: true });
    expect(notDry.status).toBe(400);
    expect(updates()).toEqual([]);
  });

  it("TIER-8: a sign-off refused after its signature was minted (the roster completed under it) records the orphan — TICKET_SIGN_SLOT_NOT_APPLIED naming the signature, no attempt", async () => {
    seed();
    const roster = await submitRouted();
    state.calls = [];
    // the roster already completed: the ticket moved on to PENDING_IFC
    state.rows.tickets = [ticketRow({ status: "PENDING_IFC", deliverable_rev: "1", attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }], metadata: { review_roster: { ...roster, closedAt: LM, closedReason: "complete" } } })];
    state.rows.e_signatures = [sig(SIG, "e-2", roster.contentHash)];
    state.user = { id: "e-2" };
    const res = await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG });
    expect(res.status).toBe(403);
    expect(updates()).toEqual([]);
    const orphan = audits().find((x) => x.action === "TICKET_SIGN_SLOT_NOT_APPLIED")!;
    expect(orphan.details).toMatchObject({ attempt: null, signatureId: SIG, refusedBeforeApply: true, status: 403 });
    // the trail's attempt pairing leaves it alone (no attempt to pair)
    const { pairTicketAttempts } = await import("@/lib/auditActions");
    expect(pairTicketAttempts([{ id: "o", action: orphan.action, details: orphan.details }]).followUps.size).toBe(0);
  });
});

describe("DF-P5 fix pass 4 — a refusal reaches the user with its reason; a broken routing table is named; only the caller's own signature is recorded", () => {
  const sig = (id: string, signer: string, hash: string, over: Record<string, unknown> = {}) => ({ id, org_id: "o1", resource_type: "ticket", resource_id: "t1", signer_user_id: signer, content_hash: hash, intent: "Reviewed", signed_at: "2099-01-01T00:00:00Z", ...over });

  it("major 1: the page's 409 handling shows the route's own refusal (routing_needs_roster → ROUTED_NO_ROSTER_REASON); only the compare-and-set conflict and holds_open keep their own handling", async () => {
    const { workflowRefusalMessage, ROUTED_NO_ROSTER_REASON } = await import("@/lib/workflow");
    seed();
    state.rows.org_members[0] = member("req-1", "Engineer-2");
    state.rows.tickets = [ticketRow({ status: "PENDING_REVIEW", requester_role: "Engineer-2", deliverable_rev: "1A", draft_iteration: 1, attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }] })];
    state.user = { id: "req-1" };
    const res = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(res.status).toBe(409);
    // exactly what the page does with the body
    expect(workflowRefusalMessage(await res.json())).toBe(ROUTED_NO_ROSTER_REASON);
    // the as-is refusal is said too
    expect(workflowRefusalMessage({ error: "The drafter marked this draft issue-as-is — reload and confirm.", code: "issue_as_is_unconfirmed" })).toMatch(/issue-as-is/);
    // the CAS conflict, a hold to resolve, and a code-less 409 keep the old handling
    expect(workflowRefusalMessage({ error: "The ticket changed while you were acting — refresh and try again", conflict: true })).toBeNull();
    expect(workflowRefusalMessage({ error: "x", code: "holds_open", holds: [] })).toBeNull();
    expect(workflowRefusalMessage({ error: "This ticket is archived" })).toBeNull();
    expect(workflowRefusalMessage(null)).toBeNull();
  });

  it("minor 6: a rosterless review under a routing table that cannot be used is refused with a reason naming the table and the document controller (not 'request a revision'); the engine uses the same reason", async () => {
    const { routedNoRosterReason, ROUTED_NO_ROSTER_REASON, WorkflowEngine } = await import("@/lib/workflow");
    seed({ routing_control: { slots: [{ kind: "x", mode: "notify_only", fill: { roles: ["Engineer"] } }] } });
    state.rows.org_members[0] = member("req-1", "Engineer-2");
    const row = ticketRow({ status: "PENDING_REVIEW", requester_role: "Engineer-2", deliverable_rev: "1A", draft_iteration: 1, attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }] });
    state.rows.tickets = [row];
    state.user = { id: "req-1" };
    const res = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; code: string };
    expect(body.code).toBe("routing_invalid");
    expect(body.error).toMatch(/library can't be used/);
    expect(body.error).toMatch(/document controller/);
    expect(body.error).not.toBe(ROUTED_NO_ROSTER_REASON);
    expect(updates()).toEqual([]);
    const reason = routedNoRosterReason({ state: "invalid", level: "collection", error: "bad slot" });
    expect(reason).toMatch(/folder can't be used \(bad slot\)/);
    expect(routedNoRosterReason({ state: "configured" })).toBe(ROUTED_NO_ROSTER_REASON);
    const { rowToTicket } = await import("@/lib/ticketTransitions");
    const offered = WorkflowEngine.getActions(rowToTicket(row as never), "Engineer-2" as never, "req-1", undefined, { reviewRouted: true, reviewRoutedReason: reason, activeMemberCount: 5 });
    expect(offered.find((a) => a.action === "approve_draft_ifc")?.disabledReason).toBe(reason);
  });

  it("minor 4: a refused sign-off records TICKET_SIGN_SLOT_NOT_APPLIED only for the caller's OWN signature on THIS ticket in THIS org — never another person's, another ticket's or org's, or an id that is no signature", async () => {
    seed();
    const roster = await submitRouted();
    const done = ticketRow({ status: "PENDING_IFC", deliverable_rev: "1", attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }], metadata: { review_roster: { ...roster, closedAt: LM, closedReason: "complete" } } });
    const orphans = () => audits().filter((x) => x.action === "TICKET_SIGN_SLOT_NOT_APPLIED");
    state.user = { id: "e-2" };
    for (const foreign of [
      sig(SIG, "e-1", roster.contentHash), // reviewer A's signature, posted by B
      sig(SIG, "e-2", roster.contentHash, { resource_id: "t-other" }), // another ticket's
      sig(SIG, "e-2", roster.contentHash, { org_id: "o-other" }), // another org's
      sig(SIG, "e-2", roster.contentHash, { resource_type: "document" }), // not a ticket signature
    ]) {
      state.calls = [];
      state.rows.tickets = [done];
      state.rows.e_signatures = [foreign];
      const res = await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG });
      expect(res.status).toBe(403);
      expect(orphans()).toEqual([]);
    }
    // an id with no signature behind it: nothing recorded
    state.calls = [];
    state.rows.e_signatures = [];
    expect((await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG })).status).toBe(403);
    expect(orphans()).toEqual([]);
    // the caller's own signature for this ticket: recorded
    state.calls = [];
    state.rows.e_signatures = [sig(SIG, "e-2", roster.contentHash)];
    expect((await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG })).status).toBe(403);
    expect(orphans()).toHaveLength(1);
    // the signature_invalid branch: another person's signature on an OPEN
    // roster is refused and NOT recorded; the caller's own (wrong hash) is
    state.calls = [];
    state.rows.tickets = [ticketRow({ status: "PENDING_REVIEW", deliverable_rev: "1A", draft_iteration: 1, attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }], metadata: { review_roster: roster } })];
    state.rows.e_signatures = [sig(SIG, "e-1", roster.contentHash)];
    const notMine = await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG });
    expect(notMine.status).toBe(403);
    expect((await notMine.json()).code).toBe("signature_invalid");
    expect(orphans()).toEqual([]);
    state.calls = [];
    state.rows.e_signatures = [sig(SIG, "e-2", "not-the-hash")];
    expect((await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG })).status).toBe(403);
    expect(orphans()).toHaveLength(1);
    expect(orphans()[0].details).toMatchObject({ signatureId: SIG, code: "signature_invalid" });
  });
});

describe("DF-P5 fix pass 4 (major 2) — the routing editor counts the requests in review a new table will stop", () => {
  const DOC_IN = "d0000000-0000-4000-8000-000000000001";
  const DOC_SUB = "d0000000-0000-4000-8000-000000000002";
  const DOC_OUT = "d0000000-0000-4000-8000-000000000003";
  const FOLDER = "f0000000-0000-4000-8000-000000000001";
  const SUB = "f0000000-0000-4000-8000-000000000002";
  const OTHER = "f0000000-0000-4000-8000-000000000003";
  const OPEN_ROSTER = { v: 1, id: "r", slots: [], files: [], contentHash: "h", openedAt: LM, openedBy: "d-1", level: "library", cycle: "1A" };
  const t = (id: string, status: string, src: string | null, over: Record<string, unknown> = {}) =>
    ({ id, status, library_id: LIB, metadata: src ? { source_document: { id: src } } : {}, ...over });
  const seedInFlight = () => {
    state.rows.tickets = [
      t("t-a", "PENDING_REVIEW", DOC_IN),
      t("t-b", "PENDING_FINAL_APPROVAL", DOC_SUB),
      t("t-c", "PENDING_REVIEW", DOC_OUT),
      t("t-d", "PENDING_REVIEW", DOC_IN, { metadata: { source_document: { id: DOC_IN }, review_roster: OPEN_ROSTER } }), // already on a roster
      t("t-e", "DRAFTING", DOC_IN), // not in review
      t("t-f", "PENDING_REVIEW", null),
      t("t-g", "PENDING_REVIEW", DOC_IN, { library_id: "other-lib" }), // another library
    ];
    state.rows.documents = [
      { id: DOC_IN, library_id: LIB, collection_id: FOLDER },
      { id: DOC_SUB, library_id: LIB, collection_id: SUB },
      { id: DOC_OUT, library_id: LIB, collection_id: OTHER },
    ];
    state.rows.collections = [
      { id: FOLDER, library_id: LIB, path_ids: [] },
      { id: SUB, library_id: LIB, path_ids: [FOLDER] },
      { id: OTHER, library_id: LIB, path_ids: [] },
    ];
  };
  it("a library counts every rosterless request in review filed in it; a folder, those whose source document sits in it or under it; a document, those raised on it", async () => {
    const { reviewsInFlightUnder } = await import("@/lib/routingControl");
    seedInFlight();
    expect(await reviewsInFlightUnder("library", LIB)).toEqual({ ok: true, n: 4, capped: false }); // a, b, c, f
    expect(await reviewsInFlightUnder("collection", FOLDER)).toEqual({ ok: true, n: 2, capped: false }); // a (in it), b (sub-folder)
    expect(await reviewsInFlightUnder("collection", SUB)).toEqual({ ok: true, n: 1, capped: false }); // b
    expect(await reviewsInFlightUnder("document", DOC_IN)).toEqual({ ok: true, n: 1, capped: false }); // a (d has a roster)
    expect(await reviewsInFlightUnder("document", DOC_OUT)).toEqual({ ok: true, n: 1, capped: false });
  });
  it("a read that fails is said (the editor still asks), never a silent zero", async () => {
    const { reviewsInFlightUnder } = await import("@/lib/routingControl");
    seedInFlight();
    state.errors.tickets = { code: "XX000", message: "boom" };
    expect(await reviewsInFlightUnder("library", LIB)).toEqual({ ok: false, error: "boom" });
  });
});
