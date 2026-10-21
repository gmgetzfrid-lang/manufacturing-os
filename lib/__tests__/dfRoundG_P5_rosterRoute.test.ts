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
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) }, __registerScopedServerClient: () => {} }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "b",
  r2: {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: { Key: string } }) => {
      const kind = cmd.constructor.name;
      state.r2.push({ kind, key: cmd.input.Key });
      if (kind === "GetObjectCommand") {
        if (state.r2Fail) throw new Error("timeout");
        return { ContentLength: BYTES.length, Body: (async function* () { yield new TextEncoder().encode(BYTES); })() };
      }
      return { ContentLength: 4096, ETag: '"e"' };
    }),
  },
}));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => ({ ok: true })) }));
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";

const post = (body: unknown) => workflowAction(new NextRequest("http://x/api/tickets/workflow-action", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const member = (uid: string, role: string, roles = [role]) => ({ org_id: "o1", uid, role, roles, email: `${uid}@x.io`, display_name: uid, status: "active" });
const DRAFT = { id: "a-d", name: "iso_1A.pdf", url: "orgs/o1/tickets/REQ-1/iso_1A.pdf", type: "Draft", status: "staged" } as TicketAttachment;
const ROUTING = { slots: [
  { kind: "accept", label: "Requester acceptance", mode: "blocking", fill: { identity: "requester" } },
  { kind: "check", label: "Engineering check", mode: "blocking", fill: { roles: ["Engineer"] }, independent_of: ["drafter"] },
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

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.errors = {}; state.r2 = []; state.r2Fail = false;
});

/** Submit as the drafter and return the roster the route wrote. */
async function submitRouted(): Promise<TicketReviewRoster> {
  state.user = { id: "d-1" };
  state.rows.tickets = [ticketRow()];
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
  it("approve_draft_ifc: the approved drafts' identity carries the sha256 the route computed from the bytes; the status is today's PENDING_IFC", async () => {
    seed();
    state.rows.org_members[0] = member("req-1", "Engineer-2");
    state.rows.tickets = [legacy()];
    state.user = { id: "req-1" };
    const res = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(res.status).toBe(200);
    expect(updates()[0].status).toBe("PENDING_IFC");
    const a = audits().find((x) => x.action === "TICKET_APPROVE_DRAFT_IFC")!;
    expect((a.details.approvedDrafts as Array<{ sha256: string }>)[0].sha256).toBe(SHA);
  });
  it("storage that cannot answer does not block the approval (today's flow): the row says the hash was unavailable", async () => {
    seed();
    state.r2Fail = true;
    state.rows.org_members[0] = member("req-1", "Engineer-2");
    state.rows.tickets = [legacy()];
    state.user = { id: "req-1" };
    const res = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(res.status).toBe(200);
    const a = audits().find((x) => x.action === "TICKET_APPROVE_DRAFT_IFC")!;
    expect((a.details.approvedDrafts as Array<Record<string, unknown>>)[0]).toMatchObject({ sha256: null, sha256Unavailable: "storage could not be read" });
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
    const res = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(res.status).toBe(200);
    const u = updates()[0];
    expect(u.status).toBe("FINAL_DRAFT");
    expect((u.attachments as TicketAttachment[]).filter((x) => x.type === "Final")).toEqual([expect.objectContaining({ url: DRAFT.url, rev: "1", issuedFromDraftId: "a-d" })]);
  });
});
