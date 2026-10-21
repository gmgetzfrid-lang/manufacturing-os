// drafting-flow Round G, DF-P7 CONSENT — the workflow route's half of GAP-109
// on GAP-113 (DEC-38, DEC-39) and EVID-9's route limb:
//   * a submission whose roster carries a configured consent slot opens the
//     window through open_consent_window AFTER the compare-and-set — the RPC
//     writes the notices and the clock together; when it refuses, the slot
//     waits for a sign-off, said, and nothing advances on silence;
//   * the seeded / unconfigured path, a pre-paste row, engineered work and an
//     empty recipient set never open one (REGRESSION + DEC-90 rulings);
//   * one of the people asked may object (comment required) — the objection
//     lands only on a running window, and is recorded;
//   * a person not emailed by their own choice gets a durable record.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { __resetCapabilityPolicyCache } from "@/lib/capabilityPolicy";
import { CONSENT_WINDOW_COLUMNS, CONSENT_REASON } from "@/lib/consentWindow";
import { ISSUE_AS_IS_NOTE } from "@/lib/workflow";
import type { TicketAttachment, TicketReviewRoster } from "@/types/schema";

const LM = "2026-10-21T00:00:00.000Z";
const LIB = "1b000000-0000-4000-8000-000000000001";
const BYTES = "%PDF-1.7 the draft";

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
  rpcResult: null as null | { data: unknown; error: null | { code?: string; message: string } },
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
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      state.calls.push({ table: `rpc:${fn}`, method: "rpc", args: [args] });
      if (fn === "open_consent_window" && state.rpcResult) return state.rpcResult;
      return { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    }),
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

const post = (body: unknown) => workflowAction(new NextRequest("http://x/api/tickets/workflow-action", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const member = (uid: string, role: string, roles = [role]) => ({ org_id: "o1", uid, role, roles, email: `${uid}@x.io`, display_name: uid, status: "active" });
const DRAFT = { id: "a-d", name: "iso_1A.pdf", url: "orgs/o1/tickets/REQ-1/iso_1A.pdf", type: "Draft", status: "staged" } as TicketAttachment;
const CONSENT_ROUTING = { slots: [
  { kind: "accept", label: "Requester acceptance", mode: "blocking", fill: { identity: "requester" } },
  { kind: "ops", label: "Operations", mode: "consent_window", consent_confirmed: true, fill: { users: ["o-1"] } },
] };
const COLS = Object.fromEntries(CONSENT_WINDOW_COLUMNS.map((c) => [c, null]));
const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "x", status: "DRAFTING", request_type: "ISO", unit: null,
  // A requester the legacy gate exempts (Manager): engineering is NOT
  // required, so the request is not the highest work class.
  requester_id: "req-1", requester_role: "Manager", assigned_drafter_id: "d-1", assigned_engineer_id: null,
  attachments: [DRAFT], comments: [], history: [], watchers: [], unread_by: [], revision_count: 0, draft_iteration: 0,
  last_modified: LM, library_id: LIB, metadata: {}, ...COLS, ...over,
});
const seed = (routing: Record<string, unknown> | null = CONSENT_ROUTING) => {
  state.rows.org_members = [member("req-1", "Manager"), member("d-1", "Drafter"), member("o-1", "Viewer"), member("e-1", "Engineer-2"), member("a-1", "Admin")];
  state.rows.libraries = [{ id: LIB, org_id: "o1", name: "P&IDs", routing_control: routing }];
  state.rows.ticket_review_slots = [];
};
const updates = () => state.calls.filter((c) => c.table === "tickets" && c.method === "update").map((c) => c.args[0] as Record<string, unknown>);
const rpcs = (fn: string) => state.calls.filter((c) => c.table === `rpc:${fn}`).map((c) => c.args[0] as Record<string, unknown>);
const inserts = (table: string) => state.calls.filter((c) => c.table === table && c.method === "insert").flatMap((c) => (Array.isArray(c.args[0]) ? c.args[0] : [c.args[0]]) as Array<Record<string, unknown>>);

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.errors = {}; state.r2 = []; state.r2Fail = false; state.r2Hang = false; state.after = []; state.rpcResult = null;
});

async function submit(over: Record<string, unknown> = {}) {
  state.user = { id: "d-1" };
  state.rows.tickets = [ticketRow(over)];
  const res = await post({ ticketId: "t1", actionType: "submit_draft" });
  const body = await res.json();
  const roster = (updates()[0]?.metadata as { review_roster?: TicketReviewRoster } | undefined)?.review_roster;
  return { res, body, roster };
}

describe("DEC-38 — the window opens after the review exists, through ONE call that writes the notices and the clock", () => {
  it("a configured consent slot on a request that is not engineered work: the roster plans the window, then open_consent_window asks the slot's own occupants (frozen)", async () => {
    seed();
    state.rpcResult = { data: 1, error: null };
    const { res, roster, body } = await submit();
    expect(res.status).toBe(200);
    expect(roster!.consentPlan).toEqual({ kind: "open", slot: "ops", label: "Operations", recipients: ["o-1"], windowDays: 3, warnFraction: 2 / 3 });
    const call = rpcs("open_consent_window");
    expect(call).toHaveLength(1);
    expect(call[0]).toMatchObject({ p_ticket: "t1", p_roster: roster!.id, p_slot: "ops", p_recipients: ["o-1"] });
    expect(Date.parse(String(call[0].p_warn_at))).toBeLessThan(Date.parse(String(call[0].p_closes_at)));
    expect((call[0].p_history as { action: string; details: string; user: string })).toMatchObject({ action: "Consent window opened — Operations", user: "system:consent-window" });
    expect((call[0].p_history as { details: string }).details).toMatch(/^Asked o-1 \(1 person\)/);
    // the RPC runs AFTER the compare-and-set (the review it stamps exists)
    const order = state.calls.filter((c) => (c.table === "tickets" && c.method === "update") || c.table === "rpc:open_consent_window").map((c) => c.table);
    expect(order).toEqual(["tickets", "rpc:open_consent_window"]);
    // the slot still waits — only the RPC's own stamp starts the clock
    expect(roster!.slots.find((s) => s.kind === "ops")).toMatchObject({ mode: "consent_window", status: "open", primaries: ["o-1"] });
    expect(body.consentWarning).toBeUndefined();
    const line = (updates()[0].history as Array<{ action: string; details?: string }>).find((h) => h.action === "Review roster opened")!;
    expect(line.details).toMatch(/"Operations" may object within 3 working days/);
  });
  it("fix pass 2 (EVID-9 for the window itself): once the RPC lands, the people asked are emailed (an assignment email, an absolute link); the history line names each channel; a person with email off is recorded", async () => {
    seed({ slots: [CONSENT_ROUTING.slots[0], { kind: "ops", label: "Operations", mode: "consent_window", consent_confirmed: true, fill: { users: ["o-1", "e-1"] } }] });
    state.rows.notification_preferences = [{ user_id: "e-1", email_on_assignment: false }];
    state.rpcResult = { data: 2, error: null };
    const { res } = await submit();
    expect(res.status).toBe(200);
    const call = rpcs("open_consent_window")[0];
    expect((call.p_history as { details: string }).details).toMatch(/Each was told in the app; by email as well: o-1; in the app only: e-1\./);
    // DEC-90 ruling (2): no preference reason in the history (any ticket reader sees it).
    expect((call.p_history as { details: string }).details).not.toMatch(/turned|preference/);
    const windowMails = inserts("email_notifications").filter((m) => (m.metadata as { action?: string } | undefined)?.action === "consent_window_opened");
    expect(windowMails.map((m) => m.to_user_id)).toEqual(["o-1"]);
    expect(windowMails[0]).toMatchObject({ event_type: "assignment", resource_id: "t1", status: "queued" });
    expect(String(windowMails[0].body_text)).toMatch(/https?:\/\/[^/\s]+\/requests\/t1/);
    expect(inserts("ticket_notice_events").filter((e) => e.kind === "not_emailed" && (e.details as { action?: string }).action === "consent_window_opened"))
      .toEqual([expect.objectContaining({ recipient: "e-1", slot_kind: "ops", details: expect.objectContaining({ byTheirChoice: true, reason: "they turned assignment emails off" }) })]);
    // the RPC first, then the emails (no notice, no email)
    const order = state.calls.filter((c) => c.table === "rpc:open_consent_window" || (c.table === "email_notifications" && c.method === "insert" && ((c.args[0] as Array<Record<string, unknown>>)[0]?.metadata as { action?: string } | undefined)?.action === "consent_window_opened")).map((c) => c.table);
    expect(order).toEqual(["rpc:open_consent_window", "email_notifications"]);
  });
  it("DEC-38: the RPC refuses (a notification insert failed) — the submission stands, the slot waits for a sign-off, and the answer says so; the refusal is recorded on the ticket's notice record", async () => {
    seed();
    state.rpcResult = { data: null, error: { code: "P0001", message: "consent window: not every person asked could be told (0 of 1) — no window is opened" } };
    const { res, body, roster } = await submit();
    expect(res.status).toBe(200);
    expect(updates()).toHaveLength(1); // only the submission's own write
    expect(roster!.slots.find((s) => s.kind === "ops")!.status).toBe("open");
    expect(body.consentWarning).toMatch(/waits for a sign-off for now: the people it asks could not all be told/);
    expect(body.warning).toBe(body.consentWarning);
    // DF-P7 fix pass: the reason outlives the response — one "blocked" notice
    // event names the failed open (no window, no clock, nothing else).
    expect(inserts("ticket_notice_events")).toEqual([expect.objectContaining({ kind: "blocked", slot_kind: "ops", recipient: null, details: expect.objectContaining({ reason: "window_not_opened", recipients: ["o-1"] }) })]);
  });
});

describe("DEC-12 / DEC-37 hold whatever the routing table declares (review blocker)", () => {
  it("the drafter is the consent slot's only occupant (independent_of drafter): BLOCKED — no window, no RPC, the queue told; the drafter's silence can never issue their own work", async () => {
    seed({ slots: [{ kind: "ops", label: "Peer check", mode: "consent_window", consent_confirmed: true, fill: { users: ["d-1"] }, independent_of: ["drafter"] }] });
    state.rpcResult = { data: 1, error: null };
    const { res, roster, body } = await submit();
    expect(res.status).toBe(200);
    expect(roster!.consentPlan).toMatchObject({ kind: "blocked", slot: "ops", reason: expect.stringMatching(/drafter or a party it must be independent of/) });
    expect(rpcs("open_consent_window")).toEqual([]);
    expect(inserts("ticket_notice_events")).toEqual([expect.objectContaining({ kind: "blocked", slot_kind: "ops" })]);
    expect(body.consentWarning).toMatch(/waits for a sign-off: the only people its routing names are the drafter/);
  });
  it("the drafter among the occupants: the window asks only the others", async () => {
    seed({ slots: [CONSENT_ROUTING.slots[0], { kind: "ops", label: "Operations", mode: "consent_window", consent_confirmed: true, fill: { users: ["d-1", "o-1"] }, independent_of: ["drafter"] }] });
    state.rpcResult = { data: 1, error: null };
    const { roster } = await submit();
    expect(roster!.consentPlan).toMatchObject({ kind: "open", recipients: ["o-1"] });
    expect(rpcs("open_consent_window")[0]).toMatchObject({ p_recipients: ["o-1"] });
  });
  it("independent_of requester with the requester the only occupant: BLOCKED — the requester's silence never approves their own request", async () => {
    seed({ slots: [{ kind: "ops", label: "Operations", mode: "consent_window", consent_confirmed: true, fill: { users: ["req-1"] }, independent_of: ["requester"] }] });
    state.rpcResult = { data: 1, error: null };
    const { roster } = await submit();
    expect(roster!.consentPlan).toMatchObject({ kind: "blocked" });
    expect(rpcs("open_consent_window")).toEqual([]);
  });
});

describe("REGRESSION + DEC-90 rulings — where no window ever opens", () => {
  it("before 20261255 (the row has no consent_window_* columns): today's roster exactly (no plan), no RPC, the slot is a sign-off, said", async () => {
    seed();
    state.rpcResult = { data: 1, error: null };
    state.user = { id: "d-1" };
    const row = ticketRow();
    for (const c of CONSENT_WINDOW_COLUMNS) delete (row as Record<string, unknown>)[c];
    state.rows.tickets = [row];
    const res = await post({ ticketId: "t1", actionType: "submit_draft" });
    const body = await res.json();
    expect(res.status).toBe(200);
    const roster = (updates()[0].metadata as { review_roster: TicketReviewRoster }).review_roster;
    expect("consentPlan" in roster).toBe(false);
    expect(rpcs("open_consent_window")).toEqual([]);
    expect(body.consentWarning).toMatch(/needs? database update 20261255/);
    const line = (updates()[0].history as Array<{ action: string; details?: string }>).find((h) => h.action === "Review roster opened")!;
    expect(line.details).not.toMatch(/object|consent/i);
  });
  it("an unconfigured workspace (no routing table): no roster, no plan, no RPC — today's path", async () => {
    seed(null);
    const { res } = await submit();
    expect(res.status).toBe(200);
    expect("metadata" in updates()[0]).toBe(false);
    expect(rpcs("open_consent_window")).toEqual([]);
  });
  it("NEVER on the highest work class: an engineered request (the legacy gate requires an engineer) gets the engineering slot and its consent slot waits for a sign-off", async () => {
    seed();
    state.rows.org_members!.push(member("req-2", "Requester"));
    state.rpcResult = { data: 1, error: null };
    const { res, roster } = await submit({ requester_id: "req-2", requester_role: "Requester" });
    expect(res.status).toBe(200);
    expect(roster!.consentPlan).toMatchObject({ kind: "sign_off", slot: "ops", reason: expect.stringMatching(/engineered work/) });
    expect(roster!.engineeringGateAdded).toBe(true);
    expect(rpcs("open_consent_window")).toEqual([]);
  });
  it("DEC-39: a consent slot whose routing named nobody active is BLOCKED — no window, the block recorded, the assignment queue told", async () => {
    seed({ slots: [CONSENT_ROUTING.slots[0], { kind: "ops", label: "Operations", mode: "consent_window", consent_confirmed: true, fill: { users: ["gone-1"] } }] });
    state.rpcResult = { data: 1, error: null };
    const { res, roster, body } = await submit();
    expect(res.status).toBe(200);
    expect(roster!.consentPlan).toMatchObject({ kind: "blocked", slot: "ops" });
    expect(roster!.slots.find((s) => s.kind === "ops")).toMatchObject({ fallback: true, status: "open" });
    expect(rpcs("open_consent_window")).toEqual([]);
    expect(inserts("ticket_notice_events")).toEqual([expect.objectContaining({ kind: "blocked", slot_kind: "ops", ticket_id: "t1" })]);
    const queueBell = inserts("notifications").filter((n) => (n.metadata as { action?: string } | null)?.action === "consent_window_blocked");
    // whoever runs the assignment queue (ticket.assign under the shipped
    // policy: the Admin and the Manager here) — never the submitting drafter
    expect(queueBell.map((n) => n.user_id).sort()).toEqual(["a-1", "req-1"]);
    expect(body.consentWarning).toMatch(/named nobody who could be asked/);
  });
});

describe("the objection (comment required) — only one of the people asked, only on a running window", () => {
  const WINDOW = { slot: "ops", openedAt: "2026-10-19T09:00:00Z", warnAt: "2026-10-21T09:00:00Z", closesAt: "2099-10-22T09:00:00Z", recipients: ["o-1"] };
  const running = (): TicketReviewRoster => ({
    v: 1, id: "11111111-1111-4111-8111-111111111111", openedAt: "2026-10-19T09:00:00Z", openedBy: "d-1", level: "library", cycle: "1A", contentHash: "h", files: [],
    slots: [
      { id: "x:accept", kind: "accept", label: "Requester acceptance", mode: "blocking", primaries: ["req-1"], alternates: [], overriders: [], independentOf: [], timeoutDays: null, fallback: false, status: "open" },
      { id: "x:ops", kind: "ops", label: "Operations", mode: "consent_window", primaries: ["o-1"], alternates: [], overriders: [], independentOf: [], timeoutDays: null, fallback: false, status: "open", windowDays: 3, warnFraction: 2 / 3 },
    ],
    consentWindow: WINDOW,
  });
  const reviewRow = () => ticketRow({ status: "PENDING_REVIEW", deliverable_rev: "1A", draft_iteration: 1, attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }], metadata: { review_roster: running() },
    consent_window_opened_at: "2026-10-19T09:00:00Z", consent_window_recipients: ["o-1"], consent_window_slot: "ops", consent_window_roster: running().id,
    consent_window_warn_at: "2026-10-21T09:00:00Z", consent_window_closes_at: "2099-10-22T09:00:00Z" });
  it("one of the people asked objects: the columns and the mirror are stamped, the slot waits for a sign-off, the CAS insists the window is still running, the objection is recorded", async () => {
    seed();
    state.user = { id: "o-1" };
    state.rows.tickets = [reviewRow()];
    const res = await post({ ticketId: "t1", actionType: "object_consent_window", comment: "The relief valve set point changed" });
    expect(res.status).toBe(200);
    const u = updates()[0];
    expect(typeof u.consent_window_objected_at).toBe("string");
    expect(u.consent_window_objected_by).toBe("o-1");
    expect(u.status).toBeUndefined();
    expect(((u.metadata as { review_roster: TicketReviewRoster }).review_roster.consentWindow)).toMatchObject({ objectedBy: "o-1" });
    const cas = state.calls.filter((c) => c.table === "tickets" && c.method === "is").map((c) => c.args[0]);
    expect(cas).toEqual(expect.arrayContaining(["consent_window_expired_at", "consent_window_objected_at"]));
    expect(inserts("ticket_notice_events")).toEqual([expect.objectContaining({ kind: "objected", recipient: "o-1", slot_kind: "ops" })]);
    const audit = inserts("audit_logs").find((a) => a.action === "TICKET_OBJECT_CONSENT_WINDOW");
    expect(audit).toBeTruthy();
  });
  it("an objection without a reason is refused (400); nothing written", async () => {
    seed();
    state.user = { id: "o-1" };
    state.rows.tickets = [reviewRow()];
    const res = await post({ ticketId: "t1", actionType: "object_consent_window" });
    expect(res.status).toBe(400);
    expect(updates()).toEqual([]);
  });
  it("someone who was not asked cannot object (403)", async () => {
    seed();
    state.user = { id: "e-1" };
    state.rows.tickets = [reviewRow()];
    const res = await post({ ticketId: "t1", actionType: "object_consent_window", comment: "no" });
    expect(res.status).toBe(403);
    expect(updates()).toEqual([]);
  });
});

describe("EVID-9 (route limb) — a person not emailed by their own choice gets a record, not silence", () => {
  it("email turned off: no email row, a not_emailed record with the reason; a person with email on is emailed as before", async () => {
    seed(null);
    state.rows.org_members!.push(member("w-1", "Viewer"));
    state.rows.notification_preferences = [{ user_id: "req-1", email_enabled: false }];
    const { res } = await submit({ watchers: ["w-1"] });
    expect(res.status).toBe(200);
    const mails = inserts("email_notifications").map((m) => m.to_user_id);
    expect(mails).toContain("w-1");
    expect(mails).not.toContain("req-1");
    const rec = inserts("ticket_notice_events");
    expect(rec).toEqual([expect.objectContaining({ kind: "not_emailed", recipient: "req-1", details: expect.objectContaining({ reason: "they turned email off", byTheirChoice: true, action: "submit_draft" }) })]);
    // never an email_notifications 'suppressed' row (the drain would re-queue it)
    expect(inserts("email_notifications").some((m) => m.status === "suppressed")).toBe(false);
  });
  it("REGRESSION: before 20261255 (the record's table is missing) the transition answers 200 exactly as before", async () => {
    seed(null);
    state.rows.notification_preferences = [{ user_id: "req-1", email_enabled: false }];
    state.errors.ticket_notice_events = { code: "PGRST205", message: "Could not find the table 'public.ticket_notice_events' in the schema cache" };
    const { res } = await submit();
    expect(res.status).toBe(200);
  });
});

describe("DF-P7 fix pass 3 — the route", () => {
  it("a consent slot stored WITHOUT the post-DF-P7 opt-in (saved when the editor said it waits like a sign-off): no window — and (DEC-90 ruling (5)) today's review byte for byte: no plan, no note, no window fields, no warning", async () => {
    seed({ slots: [CONSENT_ROUTING.slots[0], { kind: "ops", label: "Operations", mode: "consent_window", fill: { users: ["o-1"] } }] });
    state.rpcResult = { data: 1, error: null };
    const { res, roster, body } = await submit();
    expect(res.status).toBe(200);
    expect("consentPlan" in roster!).toBe(false);
    expect(rpcs("open_consent_window")).toEqual([]);
    const ops = roster!.slots.find((s) => s.kind === "ops")!;
    for (const k of ["windowDays", "warnFraction", "consentConfirmed"]) expect(k in ops).toBe(false);
    const line = (updates()[0].history as Array<{ action: string; details?: string }>).find((h) => h.action === "Review roster opened")!;
    expect(line.details).toBe("Sign-offs needed (any order): Requester acceptance, Operations");
    expect(body.consentWarning).toBeUndefined();
    expect(inserts("ticket_notice_events")).toEqual([]);
    expect(CONSENT_REASON.unconfirmed).toBeTruthy();
  });
  it("DEC-90 ruling (4): before 20261255 an unconfirmed consent slot's answer never blames the paste — no warning at all (as today), no plan, no note", async () => {
    seed({ slots: [CONSENT_ROUTING.slots[0], { kind: "ops", label: "Operations", mode: "consent_window", fill: { users: ["o-1"] } }] });
    state.user = { id: "d-1" };
    const row = ticketRow();
    for (const c of CONSENT_WINDOW_COLUMNS) delete (row as Record<string, unknown>)[c];
    state.rows.tickets = [row];
    const res = await post({ ticketId: "t1", actionType: "submit_draft" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.consentWarning).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/20261255/);
    const roster = (updates()[0].metadata as { review_roster: TicketReviewRoster }).review_roster;
    expect("consentPlan" in roster).toBe(false);
    const line = (updates()[0].history as Array<{ action: string; details?: string }>).find((h) => h.action === "Review roster opened")!;
    expect(line.details).toBe("Sign-offs needed (any order): Requester acceptance, Operations");
  });
  it("DEC-90 ruling (5): an unconfirmed consent slot on engineered work — the engineering slot is added as today, and nothing about consent is written", async () => {
    seed({ slots: [CONSENT_ROUTING.slots[0], { kind: "ops", label: "Operations", mode: "consent_window", fill: { users: ["o-1"] } }] });
    state.rows.org_members!.push(member("req-2", "Requester"));
    const { res, roster } = await submit({ requester_id: "req-2", requester_role: "Requester" });
    expect(res.status).toBe(200);
    expect(roster!.engineeringGateAdded).toBe(true);
    expect("consentPlan" in roster!).toBe(false);
    const line = (updates()[0].history as Array<{ action: string; details?: string }>).find((h) => h.action === "Review roster opened")!;
    expect(line.details).not.toMatch(/consent|object|engineered work/i);
  });
  it("FRIC-5: a submission marked issue-as-is names the mark in the window's notice, its history line and the line's key (what lets the close issue as-is)", async () => {
    seed();
    state.rpcResult = { data: 1, error: null };
    state.user = { id: "d-1" };
    state.rows.tickets = [ticketRow()];
    const res = await post({ ticketId: "t1", actionType: "submit_draft", issueReady: true });
    expect(res.status).toBe(200);
    const meta = updates()[0].metadata as { issue_ready?: { rev: string; at: string } };
    expect(meta.issue_ready?.rev).toBeTruthy();
    const call = rpcs("open_consent_window")[0];
    expect(String(call.p_body)).toContain(ISSUE_AS_IS_NOTE);
    expect(call.p_history).toMatchObject({ consentIssueAsIs: { rev: meta.issue_ready!.rev, at: meta.issue_ready!.at } });
  });
  it("…and an unmarked submission's notice carries neither", async () => {
    seed();
    state.rpcResult = { data: 1, error: null };
    await submit();
    const call = rpcs("open_consent_window")[0];
    expect(String(call.p_body)).not.toContain(ISSUE_AS_IS_NOTE);
    expect("consentIssueAsIs" in (call.p_history as Record<string, unknown>)).toBe(false);
  });
});

describe("DF-P7 final fix pass — the route (DEC-90 rulings (1) and (3))", () => {
  it("ruling (1): the submitting drafter is the only assigner — nobody is belled, and neither the history nor the answer says anyone was told", async () => {
    seed({ slots: [{ kind: "ops", label: "Peer check", mode: "consent_window", consent_confirmed: true, fill: { users: ["d-1"] }, independent_of: ["drafter"] }] });
    state.rows.org_configurations = [{ org_id: "o1", key: "capability_policy", data: { caps: { "ticket.assign": [{ tokens: ["Drafter"] }] } }, updated_at: null }];
    state.rpcResult = { data: 1, error: null };
    const { res, roster, body } = await submit();
    expect(res.status).toBe(200);
    expect(roster!.consentPlan).toMatchObject({ kind: "blocked", slot: "ops" });
    const history = JSON.stringify(updates()[0].history);
    expect(history).not.toMatch(/told/);
    expect(String(body.consentWarning)).not.toMatch(/told/);
    expect(inserts("notifications").filter((n) => (n.metadata as { action?: string } | null)?.action === "consent_window_blocked")).toEqual([]);
    expect(inserts("ticket_notice_events")).toEqual([expect.objectContaining({ kind: "blocked", details: expect.objectContaining({ escalatedTo: [] }) })]);
  });

  const SIG = "5a000000-0000-4000-8000-000000000001";
  const DECLARED = {
    engineering_required: false, review_model_filed: true, like_in_kind_statement: "Like for like: same gasket, same rating",
    like_in_kind_declared_at: "2026-10-18T09:00:00Z", like_in_kind_declared_by: "req-1", like_in_kind_signature_id: SIG,
  };
  const goodSig = { id: SIG, org_id: "o1", resource_type: "ticket", resource_id: "t1", signer_user_id: "req-1" };
  it("ruling (3) REGRESSION: a declared request whose signature stands plans and opens the window as before", async () => {
    seed();
    state.rows.e_signatures = [goodSig];
    state.rpcResult = { data: 1, error: null };
    const { res, roster } = await submit(DECLARED);
    expect(res.status).toBe(200);
    expect(roster!.consentPlan).toMatchObject({ kind: "open", recipients: ["o-1"] });
    expect(rpcs("open_consent_window")).toHaveLength(1);
  });
  it("ruling (3): the declaration's signature cannot be read ('unchecked') — the submission stands, no window is planned, the slot waits as an ordinary sign-off, said", async () => {
    seed();
    state.errors.e_signatures = { code: "57014", message: "timeout" };
    state.rpcResult = { data: 1, error: null };
    const { res, roster } = await submit(DECLARED);
    expect(res.status).toBe(200);
    expect(roster!.consentPlan).toMatchObject({ kind: "sign_off", slot: "ops", reason: CONSENT_REASON.declarationUnchecked });
    expect(roster!.slots.find((s) => s.kind === "ops")).toMatchObject({ mode: "consent_window", status: "open" });
    expect(rpcs("open_consent_window")).toEqual([]);
    const line = (updates()[0].history as Array<{ action: string; details?: string }>).find((h) => h.action === "Review roster opened")!;
    expect(line.details).toContain(CONSENT_REASON.declarationUnchecked);
  });
  it("ruling (3): the signature is known missing — engineered work: no window, the consent slot waits for a sign-off", async () => {
    seed();
    state.rows.e_signatures = [];
    state.rpcResult = { data: 1, error: null };
    const { res, roster } = await submit(DECLARED);
    expect(res.status).toBe(200);
    expect(roster!.consentPlan).toMatchObject({ kind: "sign_off", slot: "ops", reason: CONSENT_REASON.engineered });
    expect(rpcs("open_consent_window")).toEqual([]);
  });
});
