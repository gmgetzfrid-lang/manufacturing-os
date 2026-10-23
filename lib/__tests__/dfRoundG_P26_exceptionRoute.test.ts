// drafting-flow Round G, DF-P26 ISSUING-PATH STOPS — GAP-115 / GAP-109
// mechanism 3, EXCEPTION-ONLY REVIEW (DEC-90 ruling (1) for DF-P26), driven
// through the workflow route itself:
//   * REGRESSION FIRST (A/B): every action the state machine offers across
//     every status x every member, plus sign_slot / request_revision — and a
//     roster opened and completed from a table with no exception-only slot —
//     byte-identical with the route's exception-only code switched off;
//   * limb 1: a submission opening a roster with an exception-only slot
//     beside a live sign-off satisfies it by the rule — a recorded system act
//     on the history line, the audit row and the ledger (opened, then
//     satisfied via "rule" by the system actor) — only when 20261268 answers,
//     the source is unmoved, no waiver is recorded and the request is not
//     engineered; otherwise the slot waits for its sign-off (said on the
//     audit row);
//   * limb 2: the sign-off that would complete the review with no exception
//     on record issues it; with one (a waiver, a moved source, an override
//     sign-off, the request become engineered) the sign-off is recorded, the
//     rule's slot is RE-OPENED in the same compare-and-set (history, audit,
//     ledger "reopened"), and the request does not issue; its dry run says
//     so; a waiver read that fails is a 503, nothing written.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { __resetCapabilityPolicyCache } from "@/lib/capabilityPolicy";
import type { Role, Ticket, TicketAttachment, TicketReviewRoster, TicketStatus } from "@/types/schema";

const LM = "2026-10-21T00:00:00.000Z";
const LIB = "1b000000-0000-4000-8000-000000000001";
const DOC = "d0c00000-0000-4000-8000-000000000001";
const SIG = "5a000000-0000-4000-8000-000000000001";
const BYTES = "%PDF-1.7 the draft";

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  errors: {} as Record<string, { code?: string; message: string }>,
  after: [] as Array<() => unknown>,
  noP26: false,
  noNote: false,
  ready: true,
  noEO: false,
  // DF-P26 fix pass 4: only the org's "drafting" configuration row errors
  // (the permission policy, read from the same table, still reads).
  draftingDown: false,
}));
const pathGet = (r: Record<string, unknown>, key: string): unknown => {
  if (!key.includes("->")) return r[key];
  const parts = key.split(/->>?/);
  let v: unknown = r[parts[0]];
  for (const p of parts.slice(1)) v = v && typeof v === "object" ? (v as Record<string, unknown>)[p] : undefined;
  return v;
};
function chain(table: string) {
  const filters: Array<[string, unknown, "eq" | "is" | "in"]> = [];
  let head = false;
  const rows = () => (state.rows[table] ?? [])
    .filter((r) => filters.every(([k, v, how]) => (how === "is" ? (pathGet(r, k) ?? null) === v : how === "in" ? (v as unknown[]).includes(pathGet(r, k)) : pathGet(r, k) === v)))
    .map((r) => ({ ...r }));
  const c: Record<string, unknown> = {};
  const errOf = () => state.errors[table]
    ?? (state.draftingDown && table === "org_configurations" && filters.some(([k, v]) => k === "key" && v === "drafting") ? { code: "08006", message: "down" } : undefined);
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => {
        if (head && state.errors[table] && /PGRST205|42P01/.test(state.errors[table].code ?? "")) return resolve({ data: null, error: null, count: null, status: 204 });
        if (errOf()) return resolve({ data: null, error: errOf() });
        if (head) return resolve({ data: null, error: null, count: rows().length });
        return resolve({ data: rows(), error: null, count: rows().length });
      };
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "insert" && (table === "ticket_review_slots" || table === "ticket_review_slot_events") && !state.errors[table]) {
          state.rows[table] = [...(state.rows[table] ?? []), ...(Array.isArray(args[0]) ? args[0] : [args[0]]) as Array<Record<string, unknown>>];
        }
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (prop === "eq") filters.push([String(args[0]), args[1], "eq"]);
        if (prop === "is") filters.push([String(args[0]), args[1], "is"]);
        if (prop === "in") filters.push([String(args[0]), args[1], "in"]);
        if (prop === "maybeSingle" || prop === "single") {
          if (errOf()) return Promise.resolve({ data: null, error: errOf() });
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
    rpc: vi.fn(async (fn: string) => { state.calls.push({ table: `rpc:${fn}`, method: "rpc", args: [] }); return fn === "exception_only_review_ready" && state.ready ? { data: true, error: null } : { data: null, error: { code: "PGRST202", message: "Could not find the function" } }; }),
  },
}));
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) }, __registerScopedServerClient: () => {} }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn((fn: () => unknown) => { state.after.push(fn); }) }));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "b",
  r2: {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: { Key: string } }) => {
      if (cmd.constructor.name === "GetObjectCommand") return { ContentLength: BYTES.length, Body: (async function* () { yield new TextEncoder().encode(BYTES); })() };
      return { ContentLength: 4096, ETag: '"e"' };
    }),
  },
}));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => ({ ok: true })) }));
// A/B: with noP26 the route's single gate call decides "none" without
// running anything — the route without DF-P26's hold stop.
vi.mock("@/lib/requestHoldStop", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/requestHoldStop")>();
  return { ...real, issueHoldStopGate: (...a: Parameters<typeof real.issueHoldStopGate>) => (state.noP26 ? Promise.resolve({ kind: "none" as const }) : real.issueHoldStopGate(...a)) };
});
// GAP-102 acceptance 2 (DF-P26): arm B of the regression sweep also removes
// the issue notice's examination line (the route without DF-P26 at all).
vi.mock("@/lib/issueNoticeExamination", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/issueNoticeExamination")>();
  return { ...real, issueExaminationNote: (...a: Parameters<typeof real.issueExaminationNote>) => (state.noNote ? Promise.resolve(null) : real.issueExaminationNote(...a)) };
});
// GAP-115 A/B: with noEO the route sees no exception-only slot and no slot
// satisfied by the rule — the route without DF-P26's exception-only review.
vi.mock("@/lib/exceptionOnlyReview", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/exceptionOnlyReview")>();
  return {
    ...real,
    rosterHasExceptionOnlySlot: (...a: Parameters<typeof real.rosterHasExceptionOnlySlot>) => (state.noEO ? false : real.rosterHasExceptionOnlySlot(...a)),
    ruleSatisfiedSlots: (...a: Parameters<typeof real.ruleSatisfiedSlots>) => (state.noEO ? [] : real.ruleSatisfiedSlots(...a)),
  };
});
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";
import { WorkflowEngine } from "@/lib/workflow";
import { rowToTicket } from "@/lib/ticketTransitions";

const post = (body: unknown) => workflowAction(new NextRequest("http://x/api/tickets/workflow-action", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const member = (uid: string, role: string, roles = [role]) => ({ org_id: "o1", uid, role, roles, email: `${uid}@x.io`, display_name: uid, status: "active" });
const DRAFT = { id: "a-d", name: "iso_1A.pdf", url: "orgs/o1/tickets/REQ-1/iso_1A.pdf", type: "Draft", status: "staged" } as TicketAttachment;
// The requester is a Manager: the request is not engineered work (management is exempt from the engineer gate).
const MEMBERS = [member("req-1", "Manager"), member("d-1", "Drafter"), member("e-1", "Engineer-2"), member("e-2", "Engineer-3"), member("a-1", "Admin"), member("q-1", "Viewer"), member("q-2", "Viewer")];
const STATUSES: TicketStatus[] = ["PENDING_ENG_TEAM", "PENDING_ASSIGNMENT", "DRAFTING", "REVISION_REQ", "PENDING_REVIEW", "PENDING_IFC", "FINAL_DRAFT", "PENDING_FINAL_APPROVAL", "CLOSED", "CANCELED"];
const LEAD = { kind: "lead", label: "Lead check", mode: "blocking", fill: { users: ["e-2"] }, independent_of: ["drafter"], waivable_by: { roles: ["Admin"] } };
const DOCCHK = { kind: "doc", label: "Document check", mode: "blocking", fill: { users: ["q-1"] }, exception_only: true };
const WITH_EO = { slots: [LEAD, DOCCHK] };
const WITHOUT_EO = { slots: [LEAD, { ...DOCCHK, exception_only: undefined }] };

const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "x", status: "DRAFTING", request_type: "ISO", unit: null,
  requester_id: "req-1", requester_role: "Manager", assigned_drafter_id: "d-1", assigned_engineer_id: null,
  attachments: [DRAFT], comments: [], history: [], watchers: [], unread_by: [], revision_count: 0, draft_iteration: 0,
  last_modified: LM, library_id: LIB, created_at: "2026-10-05T00:00:00.000Z", metadata: {}, ...over,
});
const reviewRow = (over: Record<string, unknown> = {}) => ticketRow({ status: "PENDING_REVIEW", deliverable_rev: "1A", draft_iteration: 1, attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }], ...over });
const reset = () => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.errors = {}; state.after = []; state.noP26 = false; state.noNote = false; state.ready = true; state.noEO = false; state.draftingDown = false;
};
const seed = (routing: unknown = null) => {
  state.rows.org_members = MEMBERS.map((m) => ({ ...m }));
  state.rows.libraries = [{ id: LIB, org_id: "o1", name: "P&IDs", routing_control: routing }];
  state.rows.documents = [{ id: DOC, org_id: "o1", collection_id: null, library_id: LIB, routing_control: null, rev: "2", current_version_id: null, document_number: "P-100" }];
  state.rows.ticket_review_slots = [];
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const normal = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "function" ? "[fn]" : x)).replace(UUID, "<uuid>").replace(ISO, "<ts>");
const ticketUpdates = () => state.calls.filter((c) => c.table === "tickets" && c.method === "update");
const auditRow = () => state.calls.find((c) => c.table === "audit_logs" && c.method === "insert" && /^TICKET_[A-Z_]+$/.test(String((c.args[0] as { action?: string }).action)) && !String((c.args[0] as { action?: string }).action).endsWith("_FILES_HASHED"))?.args[0] as { action: string; details: Record<string, unknown> } | undefined;
const writesTo = (table: string, method: string) => state.calls.filter((c) => c.table === table && c.method === method).map((c) => c.args[0]);

beforeEach(() => { reset(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-22T08:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); });

async function submit(routing: unknown, metadata: Record<string, unknown> = { source_document: { id: DOC, document_number: "P-100", rev: "2" } }, extra: (() => void) | null = null) {
  reset();
  seed(routing);
  if (extra) extra();
  state.user = { id: "d-1" };
  state.rows.tickets = [ticketRow({ metadata })];
  const res = await post({ ticketId: "t1", actionType: "submit_draft" });
  const json = await res.json();
  for (const fn of state.after.splice(0)) await fn();
  const upd = ticketUpdates()[0]?.args[0] as { metadata?: { review_roster?: TicketReviewRoster }; history?: Array<{ action: string; details?: string }> } | undefined;
  return { status: res.status, json, roster: upd?.metadata?.review_roster ?? null, history: upd?.history ?? [] };
}

async function run(row: Record<string, unknown>, uid: string, body: Record<string, unknown>, routing: unknown, opts: { noEO?: boolean; extra?: () => void } = {}) {
  reset();
  seed(routing);
  state.noEO = opts.noEO === true;
  state.rows.tickets = [row];
  const roster = (row.metadata as { review_roster?: TicketReviewRoster }).review_roster;
  state.rows.ticket_review_slots = (roster?.slots ?? []).map((x) => ({ org_id: "o1", ticket_id: "t1", roster_id: roster!.id, slot_kind: x.kind, mode: x.mode, status: x.status }));
  state.rows.e_signatures = [{ id: SIG, org_id: "o1", resource_type: "ticket", resource_id: "t1", signer_user_id: uid, content_hash: roster?.contentHash ?? "h", intent: "Reviewed", signed_at: "2099-01-01T00:00:00Z" }];
  if (opts.extra) opts.extra();
  state.user = { id: uid };
  const res = await post({ ticketId: "t1", ...body });
  const json = await res.json().catch(() => null);
  for (const fn of state.after.splice(0)) await fn();
  return { status: res.status, json, njson: normal(json), calls: normal(state.calls) };
}

describe("REGRESSION FIRST — without an exception-only slot the route is today's, byte for byte", () => {
  it("every action x status x member (no roster): identical with the exception-only code switched off", async () => {
    let combos = 0;
    for (const status of STATUSES) {
      for (const m of MEMBERS) {
        const row = status === "PENDING_REVIEW" || status === "PENDING_FINAL_APPROVAL" ? reviewRow({ status, assigned_engineer_id: status === "PENDING_FINAL_APPROVAL" ? "e-1" : null }) : ticketRow({ status });
        const t = rowToTicket(row as never) as Ticket;
        const offered = WorkflowEngine.getActions(t, m.role as Role, m.uid, undefined, { userRoles: m.roles as Role[] }).map((a) => a.action);
        for (const actionType of [...new Set([...offered, "sign_slot", "request_revision"])]) {
          const body = { actionType, comment: "a reason", signatureId: SIG, issueAsIsAcknowledged: true };
          const a = await run(row, m.uid, body, null);
          const b = await run(row, m.uid, body, null, { noEO: true });
          const where = `${status} ${m.uid} ${actionType}`;
          expect(a.status, where).toBe(b.status);
          expect(a.njson, where).toBe(b.njson);
          expect(a.calls, where).toBe(b.calls);
          expect(a.calls, where).not.toMatch(/exception_only_review_ready|exceptionReview/);
          combos++;
        }
      }
    }
    expect(combos).toBeGreaterThan(100);
  }, 240_000);
  it("a roster opened from a table with NO exception-only slot, and its completing sign-off (and dry run), are identical with the code off; no probe, no key", async () => {
    const a = await submit(WITHOUT_EO);
    const aCalls = normal(state.calls);
    reset();
    seed(WITHOUT_EO);
    state.noEO = true;
    state.user = { id: "d-1" };
    state.rows.tickets = [ticketRow({ metadata: { source_document: { id: DOC, document_number: "P-100", rev: "2" } } })];
    const bRes = await post({ ticketId: "t1", actionType: "submit_draft" });
    for (const fn of state.after.splice(0)) await fn();
    expect(a.status).toBe(bRes.status);
    expect(aCalls).toBe(normal(state.calls));
    expect(aCalls).not.toMatch(/exception_only_review_ready|exceptionReview/);
    const row = reviewRow({ metadata: { source_document: { id: DOC, document_number: "P-100", rev: "2" }, review_roster: a.roster } });
    // q-1 signs "doc" first, then e-2 completes with "lead"
    const signedDoc: TicketReviewRoster = { ...a.roster!, slots: a.roster!.slots.map((x) => (x.kind === "doc" ? { ...x, status: "satisfied" as const, satisfiedBy: "q-1", signatureId: "s-q", via: "primary" as const, satisfiedAt: LM } : x)) };
    const row2 = { ...row, metadata: { ...(row.metadata as object), review_roster: signedDoc } };
    for (const dryRun of [true, false]) {
      const x = await run(row2, "e-2", { actionType: "sign_slot", signatureId: SIG, dryRun }, WITHOUT_EO);
      const y = await run(row2, "e-2", { actionType: "sign_slot", signatureId: SIG, dryRun }, WITHOUT_EO, { noEO: true });
      expect(x.status).toBe(y.status);
      expect(x.njson).toBe(y.njson);
      expect(x.calls).toBe(y.calls);
      expect(x.calls).not.toMatch(/exception_only_review_ready|exceptionReview|reopened/);
    }
  });
});

describe("limb 1 — satisfied at open by a recorded system act naming the rule", () => {
  it("nothing on record: the slot is satisfied by the rule; history, audit row and ledger name it; the live sign-off still waits", async () => {
    const r = await submit(WITH_EO);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("PENDING_REVIEW");
    const doc = r.roster!.slots.find((x) => x.kind === "doc")!;
    const lead = r.roster!.slots.find((x) => x.kind === "lead")!;
    expect(doc).toMatchObject({ status: "satisfied", via: "rule", satisfiedBy: null, signatureId: null, exceptionOnly: true });
    expect(lead.status).toBe("open");
    expect(r.history.find((h) => h.action === "Review roster opened")!.details).toContain("Satisfied by rule (exception-only review — no exception on record): Document check.");
    expect(auditRow()!.details.exceptionReview).toEqual({ satisfiedByRule: ["doc"], rule: "exception_only" });
    // ledger: opened (as open), then satisfied via the rule by the system actor
    const inserted = writesTo("ticket_review_slots", "insert")[0] as Array<{ slot_kind: string; status: string }>;
    expect(inserted.find((x) => x.slot_kind === "doc")!.status).toBe("open");
    expect(writesTo("ticket_review_slots", "update")).toContainEqual(expect.objectContaining({ status: "satisfied", satisfied_via: "rule", satisfied_by: null, signature_id: null }));
    const events = (writesTo("ticket_review_slot_events", "insert") as Array<Array<Record<string, unknown>>>).flat();
    expect(events).toContainEqual(expect.objectContaining({ slot_kind: "doc", event: "satisfied", actor_id: null, actor_name: "System — exception-only review", details: { via: "rule" } }));
  });
  it("before 20261268 (the probe missing): nothing applied — the slot waits for its sign-off, and the audit row says why", async () => {
    const r = await submit(WITH_EO, undefined, () => { state.ready = false; });
    expect(r.roster!.slots.find((x) => x.kind === "doc")!.status).toBe("open");
    expect(auditRow()!.details.exceptionReview).toEqual({ ruleNotApplied: "not_migrated", slots: ["doc"] });
  });
  it("a moved source, a recorded waiver, or an unreadable source: not applied", async () => {
    const moved = await submit(WITH_EO, undefined, () => { state.rows.documents[0].rev = "3"; });
    expect(moved.roster!.slots.find((x) => x.kind === "doc")!.status).toBe("open");
    expect(auditRow()!.details.exceptionReview).toMatchObject({ ruleNotApplied: "source_moved" });
    const waived = await submit(WITH_EO, undefined, () => { state.rows.ticket_examination_scopes = [{ ticket_id: "t1", org_id: "o1", field_values: {}, waiver: { reason: "r" } }]; });
    expect(waived.roster!.slots.find((x) => x.kind === "doc")!.status).toBe("open");
    expect(auditRow()!.details.exceptionReview).toMatchObject({ ruleNotApplied: "waiver" });
  });
  it("NEVER on engineered work (a requester who is not exempt from the engineer gate)", async () => {
    reset();
    const r = await (async () => {
      seed(WITH_EO);
      state.rows.org_members = state.rows.org_members.map((x) => (x.uid === "req-1" ? { ...x, role: "Viewer", roles: ["Viewer"] } : x));
      state.user = { id: "d-1" };
      state.rows.tickets = [ticketRow({ requester_role: "Viewer", metadata: { source_document: { id: DOC, rev: "2" } } })];
      const res = await post({ ticketId: "t1", actionType: "submit_draft" });
      return { status: res.status, roster: (ticketUpdates()[0]?.args[0] as { metadata: { review_roster: TicketReviewRoster } }).metadata.review_roster };
    })();
    expect(r.status).toBe(200);
    expect(r.roster.slots.find((x) => x.kind === "doc")!.status).toBe("open");
    expect(auditRow()!.details.exceptionReview).toMatchObject({ ruleNotApplied: "engineered" });
    expect(state.calls.some((c) => c.table === "rpc:exception_only_review_ready")).toBe(false);
  });
  it("DF-P26 fix pass 4 (DEC-90 ruling (1), fail-safe): the workspace's request types UNREADABLE — whether the request is engineered work is unknown, so nothing is applied (never assumed not engineered); the slot waits, the audit row says unchecked", async () => {
    // an engineering-first ISO type the route cannot see while the row is down
    const r = await submit(WITH_EO, undefined, () => {
      state.rows.org_configurations = [{ org_id: "o1", key: "drafting", data: { requestTypes: { options: [{ value: "ISO", label: "ISO", engineeringFirst: true }] } } }];
      state.draftingDown = true;
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.roster!.slots.find((x) => x.kind === "doc")).toMatchObject({ status: "open" });
    expect(r.roster!.slots.find((x) => x.kind === "doc")!.via).toBeUndefined();
    expect(auditRow()!.details.exceptionReview).toEqual({ ruleNotApplied: "unchecked", slots: ["doc"] });
    expect(state.calls.some((c) => c.table === "rpc:exception_only_review_ready")).toBe(false);
    expect(writesTo("ticket_review_slots", "update")).not.toContainEqual(expect.objectContaining({ satisfied_via: "rule" }));
    // the same row readable (types not engineering-first): the rule applies — the read was the only difference
    const ok = await submit(WITH_EO, undefined, () => { state.rows.org_configurations = [{ org_id: "o1", key: "drafting", data: { requestTypes: { options: [{ value: "ISO", label: "ISO" }] } } }]; });
    expect(ok.roster!.slots.find((x) => x.kind === "doc")).toMatchObject({ status: "satisfied", via: "rule" });
  });
});

describe("limb 2 — re-opened before anything issues", () => {
  async function ruledRow(): Promise<Record<string, unknown>> {
    const r = await submit(WITH_EO);
    return reviewRow({ metadata: { source_document: { id: DOC, document_number: "P-100", rev: "2" }, review_roster: r.roster } });
  }
  it("no exception on record: the live sign-off completes the review and issues it", async () => {
    const row = await ruledRow();
    const r = await run(row, "e-2", { actionType: "sign_slot", signatureId: SIG }, WITH_EO);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("PENDING_IFC");
    expect(r.json.exceptionReopened).toBeUndefined();
  });
  it("a waiver recorded since: the sign-off is recorded, the rule's slot RE-OPENED in the same write, the request does not issue; history, audit row, ledger and answer say so", async () => {
    const row = await ruledRow();
    const extra = () => { state.rows.ticket_examination_scopes = [{ ticket_id: "t1", org_id: "o1", field_values: {}, waiver: { reason: "vendor data" } }]; };
    const dry = await run(row, "e-2", { actionType: "sign_slot", dryRun: true }, WITH_EO, { extra });
    expect(dry.status).toBe(200);
    expect(dry.json).toMatchObject({ dryRun: true, exceptionReopens: ["Document check"], exceptionReopenReasons: ["a waiver of required examination data is recorded"] });
    const r = await run(row, "e-2", { actionType: "sign_slot", signatureId: SIG }, WITH_EO, { extra });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("PENDING_REVIEW");
    expect(r.json.exceptionReopened).toEqual({ slots: ["Document check"], exceptions: ["a waiver of required examination data is recorded"] });
    expect(r.json.warning).toMatch(/^Re-opened for its reviewer: Document check — exception-only review no longer stands because a waiver of required examination data is recorded\./);
    const upd = ticketUpdates()[0].args[0] as { status?: string; metadata: { review_roster: TicketReviewRoster }; history: Array<{ action: string; details?: string }>; unread_by: string[] };
    expect(upd.status).toBeUndefined();
    const slots = upd.metadata.review_roster.slots;
    expect(slots.find((x) => x.kind === "lead")).toMatchObject({ status: "satisfied", satisfiedBy: "e-2", via: "primary" });
    expect(slots.find((x) => x.kind === "doc")).toMatchObject({ status: "open", exceptionReopened: { exceptions: ["a waiver of required examination data is recorded"] } });
    expect(upd.history.at(-1)!.details, JSON.stringify(upd.history.at(-1))).toMatch(/^Re-opened for its reviewer: Document check — exception-only review no longer stands because a waiver of required examination data is recorded\. The request does not issue until it is signed\.$/);
    expect(upd.unread_by).toContain("q-1");
    expect(auditRow()!.details.exceptionReview).toEqual({ reopened: ["doc"], exceptions: ["a waiver of required examination data is recorded"] });
    expect(writesTo("ticket_review_slots", "update")).toContainEqual({ status: "open", satisfied_by: null, satisfied_at: null, satisfied_via: null, signature_id: null });
    const events = (writesTo("ticket_review_slot_events", "insert") as Array<Array<Record<string, unknown>>>).flat();
    expect(events).toContainEqual(expect.objectContaining({ slot_kind: "doc", event: "reopened", details: { via: "rule", exceptions: ["a waiver of required examination data is recorded"] } }));
    expect(events).toContainEqual(expect.objectContaining({ slot_kind: "lead", event: "satisfied" }));
  });
  it("a source that moved since: re-opened (whatever the approver acknowledges)", async () => {
    const row = await ruledRow();
    const r = await run(row, "e-2", { actionType: "sign_slot", signatureId: SIG, sourceDriftAcknowledged: true }, WITH_EO, { extra: () => { state.rows.documents[0].rev = "3"; } });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("PENDING_REVIEW");
    expect(r.json.exceptionReopened.exceptions[0]).toMatch(/^the source revision has moved since the request was raised \(P-100 raised on Rev 2, now Rev 3\)$/);
  });
  it("an override sign-off: the overrider's act is recorded, the rule's slot re-opened", async () => {
    const row = await ruledRow();
    const r = await run(row, "a-1", { actionType: "sign_slot", signatureId: SIG }, WITH_EO);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("PENDING_REVIEW");
    expect(r.json.exceptionReopened.exceptions).toEqual(['"Lead check" was signed as an override']);
  });
  it("the waiver row unreadable: 503, nothing written (the dry run too); the request never issues over it", async () => {
    const row = await ruledRow();
    for (const dryRun of [true, false]) {
      const r = await run(row, "e-2", { actionType: "sign_slot", signatureId: SIG, dryRun }, WITH_EO, { extra: () => { state.errors.ticket_examination_scopes = { code: "08006", message: "down" }; } });
      expect(r.status, `${dryRun}`).toBe(503);
      expect(r.json.code).toBe("exception_review_unchecked");
      expect(ticketUpdates()).toEqual([]);
    }
  });
  it("DF-P26 fix pass 3 (DEC-90 rulings (1) and (4)): an unreadable waiver read never refuses a sign-off that does NOT complete the review — it is taken, nothing re-opened; the completing sign-off is still refused 503", async () => {
    const LEAD2 = { kind: "lead2", label: "Second check", mode: "blocking", fill: { users: ["e-1"] }, independent_of: ["drafter"] };
    const THREE = { slots: [LEAD, LEAD2, DOCCHK] };
    const opened = await submit(THREE);
    expect(opened.roster!.slots.find((x) => x.kind === "doc")).toMatchObject({ status: "satisfied", via: "rule" });
    const row = reviewRow({ metadata: { source_document: { id: DOC, document_number: "P-100", rev: "2" }, review_roster: opened.roster } });
    const down = () => { state.errors.ticket_examination_scopes = { code: "08006", message: "down" }; };
    for (const dryRun of [true, false]) {
      const partial = await run(row, "e-2", { actionType: "sign_slot", signatureId: SIG, dryRun }, THREE, { extra: down });
      expect(partial.status, `${dryRun} ${JSON.stringify(partial.json)}`).toBe(200);
      expect(partial.json.exceptionReopens).toBeUndefined();
      expect(partial.json.exceptionReopened).toBeUndefined();
    }
    const taken = (ticketUpdates()[0].args[0] as { status?: string; metadata: { review_roster: TicketReviewRoster } });
    expect(taken.status).toBeUndefined();
    const after = taken.metadata.review_roster;
    expect(after.slots.find((x) => x.kind === "lead")).toMatchObject({ status: "satisfied", satisfiedBy: "e-2" });
    expect(after.slots.find((x) => x.kind === "doc")).toMatchObject({ status: "satisfied", via: "rule" });
    // the sign-off that WOULD complete the review: refused 503, nothing written
    const row2 = { ...row, metadata: { ...(row.metadata as object), review_roster: after } };
    for (const dryRun of [true, false]) {
      const done = await run(row2, "e-1", { actionType: "sign_slot", signatureId: SIG, dryRun }, THREE, { extra: down });
      expect(done.status, `${dryRun}`).toBe(503);
      expect(done.json.code).toBe("exception_review_unchecked");
      expect(ticketUpdates()).toEqual([]);
    }
  });
  it("DF-P26 fix pass 4 (DEC-90 ruling (1), fail-safe): the workspace's request types UNREADABLE when the completing sign-off arrives — 503 exception_review_unchecked, nothing written (the dry run too); never issued as \"not engineered\"", async () => {
    const row = await ruledRow();
    const down = () => {
      state.rows.org_configurations = [{ org_id: "o1", key: "drafting", data: { requestTypes: { options: [{ value: "ISO", label: "ISO", engineeringFirst: true }] } } }];
      state.draftingDown = true;
    };
    for (const dryRun of [true, false]) {
      const r = await run(row, "e-2", { actionType: "sign_slot", signatureId: SIG, dryRun }, WITH_EO, { extra: down });
      expect(r.status, `${dryRun} ${JSON.stringify(r.json)}`).toBe(503);
      expect(r.json.code).toBe("exception_review_unchecked");
      expect(r.json.error).toMatch(/whether the request is engineered work\) could not be checked/);
      expect(ticketUpdates()).toEqual([]);
      expect(writesTo("ticket_review_slot_events", "insert")).toEqual([]);
    }
    // readable again, and the type now engineering-first: an exception on record — re-opened, not issued
    const back = await run(row, "e-2", { actionType: "sign_slot", signatureId: SIG }, WITH_EO, { extra: () => { down(); state.draftingDown = false; } });
    expect(back.status, JSON.stringify(back.json)).toBe(200);
    expect(back.json.status).toBe("PENDING_REVIEW");
    expect(back.json.exceptionReopened).toBeTruthy();
  });
  it("DF-P26 fix pass 4: the request types unreadable on a sign-off that does NOT complete the review — taken (200), nothing re-opened; the completing one still waits", async () => {
    const LEAD2 = { kind: "lead2", label: "Second check", mode: "blocking", fill: { users: ["e-1"] }, independent_of: ["drafter"] };
    const THREE = { slots: [LEAD, LEAD2, DOCCHK] };
    const opened = await submit(THREE);
    const row = reviewRow({ metadata: { source_document: { id: DOC, document_number: "P-100", rev: "2" }, review_roster: opened.roster } });
    const down = () => { state.draftingDown = true; };
    const partial = await run(row, "e-2", { actionType: "sign_slot", signatureId: SIG }, THREE, { extra: down });
    expect(partial.status, JSON.stringify(partial.json)).toBe(200);
    expect(partial.json.exceptionReopened).toBeUndefined();
    const after = (ticketUpdates()[0].args[0] as { metadata: { review_roster: TicketReviewRoster } }).metadata.review_roster;
    expect(after.slots.find((x) => x.kind === "doc")).toMatchObject({ status: "satisfied", via: "rule" });
    const row2 = { ...row, metadata: { ...(row.metadata as object), review_roster: after } };
    const done = await run(row2, "e-1", { actionType: "sign_slot", signatureId: SIG }, THREE, { extra: down });
    expect(done.status).toBe(503);
    expect(done.json.code).toBe("exception_review_unchecked");
    expect(ticketUpdates()).toEqual([]);
  });
  it("DF-P26 review fix: more source documents than one read takes (101): 503 exception_review_unchecked, nothing written — never only the first 100 read", async () => {
    const row = await ruledRow();
    const many = Array.from({ length: 101 }, (_, i) => ({ id: `d0c00000-0000-4000-8000-${String(i + 2).padStart(12, "0")}`, document_number: `P-${i + 2}`, rev: "1" }));
    const row101 = { ...row, metadata: { ...(row.metadata as object), source_documents: many } };
    for (const dryRun of [true, false]) {
      const r = await run(row101, "e-2", { actionType: "sign_slot", signatureId: SIG, dryRun }, WITH_EO);
      expect(r.status, `${dryRun}`).toBe(503);
      expect(r.json.code).toBe("exception_review_unchecked");
      expect(ticketUpdates()).toEqual([]);
    }
  });
  it("DF-P26 review fix: a like-in-kind declaration whose signature could not be READ is a retry (503), never a recorded exception — nothing re-opened (sign_slot is in DECLARATION_DECIDES, so the route refuses before limb 2; limb 2 refuses an \"unchecked\" too, and exceptionsOnRecord never counts one)", async () => {
    const row = await ruledRow();
    const DSIG = "5a000000-0000-4000-8000-0000000000dd";
    const declared = { ...row, engineering_required: false, like_in_kind_statement: "same as before", like_in_kind_declared_at: "2026-10-05T00:00:00.000Z", like_in_kind_declared_by: "req-1", like_in_kind_signature_id: DSIG };
    for (const dryRun of [true, false]) {
      const r = await run(declared, "e-2", { actionType: "sign_slot", signatureId: SIG, dryRun }, WITH_EO, { extra: () => { state.errors.e_signatures = { code: "08006", message: "down" }; } });
      expect(r.status, `${dryRun} ${JSON.stringify(r.json)}`).toBe(503);
      expect(r.json.code).toBe("declaration_unreadable");
      expect(ticketUpdates()).toEqual([]);
      expect(writesTo("ticket_review_slot_events", "insert")).toEqual([]);
    }
  });
  it("DF-P26 review fix: the rule's slot's own reviewer may still sign it — the sign-off upgrades the rule's (ledger satisfied by the person); nothing to re-open", async () => {
    const row = await ruledRow();
    const r = await run(row, "q-1", { actionType: "sign_slot", signatureId: SIG }, WITH_EO);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.status).toBe("PENDING_REVIEW");
    expect(r.json.exceptionReopened).toBeUndefined();
    const slots = (ticketUpdates()[0].args[0] as { metadata: { review_roster: TicketReviewRoster } }).metadata.review_roster.slots;
    expect(slots.find((x) => x.kind === "doc")).toMatchObject({ status: "satisfied", via: "primary", satisfiedBy: "q-1", signatureId: SIG });
    expect(writesTo("ticket_review_slots", "update")).toContainEqual(expect.objectContaining({ status: "satisfied", satisfied_by: "q-1", satisfied_via: "primary", signature_id: SIG }));
    const events = (writesTo("ticket_review_slot_events", "insert") as Array<Array<Record<string, unknown>>>).flat();
    expect(events).toContainEqual(expect.objectContaining({ slot_kind: "doc", event: "satisfied" }));
    expect(events.some((e) => e.event === "reopened")).toBe(false);
  });
  it("DF-P26 merge-time fix pass (DEC-90 rulings (1) and (4)): a completing sign-off that upgrades EVERY rule-satisfied slot leaves nothing to re-open — an unreadable waiver read never refuses it: 200 and the request issues (the dry run too)", async () => {
    // e-2 is named on the live lead check AND on the exception-only document check: the rule satisfied the
    // document check at open (the lead check still waited on e-2); e-2's one sign-off covers both.
    const BOTH = { slots: [LEAD, { ...DOCCHK, fill: { users: ["e-2"] } }] };
    const opened = await submit(BOTH);
    expect(opened.roster!.slots.find((x) => x.kind === "doc")).toMatchObject({ status: "satisfied", via: "rule" });
    const row = reviewRow({ metadata: { source_document: { id: DOC, document_number: "P-100", rev: "2" }, review_roster: opened.roster } });
    const down = () => { state.errors.ticket_examination_scopes = { code: "08006", message: "down" }; };
    const dry = await run(row, "e-2", { actionType: "sign_slot", dryRun: true }, BOTH, { extra: down });
    expect(dry.status, JSON.stringify(dry.json)).toBe(200);
    expect(dry.json.slots).toEqual(["Lead check", "Document check"]);
    expect(dry.json.exceptionReopens).toBeUndefined();
    const r = await run(row, "e-2", { actionType: "sign_slot", signatureId: SIG }, BOTH, { extra: down });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.status).toBe("PENDING_IFC");
    expect(r.json.exceptionReopened).toBeUndefined();
    const slots = (ticketUpdates()[0].args[0] as { metadata: { review_roster: TicketReviewRoster } }).metadata.review_roster.slots;
    expect(slots.find((x) => x.kind === "doc")).toMatchObject({ status: "satisfied", via: "primary", satisfiedBy: "e-2" });
    expect(slots.find((x) => x.kind === "lead")).toMatchObject({ status: "satisfied", via: "primary", satisfiedBy: "e-2" });
    expect(r.calls).not.toMatch(/"reopened"/);
    // REGRESSION (kept, unchanged): a completing sign-off that leaves a rule-satisfied slot is still refused 503 on
    // the unreadable read — the "the waiver row unreadable: 503, nothing written" case above.
  });
  it("DF-P26 merge-time fix pass: the route signs what the plan now offers — the reviewer named on an open slot independent of the rule's slot signs THAT slot (either table order, either direction); the rule's slot stays satisfied by the rule; nothing more is open to them after", async () => {
    const XCHK = { kind: "xchk", label: "Cross check", mode: "blocking", fill: { users: ["q-1"] } };
    for (const dir of ["x-of-doc", "doc-of-x"] as const) {
      const x = dir === "x-of-doc" ? { ...XCHK, independent_of: ["doc"] } : XCHK;
      const d = dir === "doc-of-x" ? { ...DOCCHK, independent_of: ["xchk"] } : DOCCHK;
      for (const table of [{ slots: [LEAD, d, x] }, { slots: [LEAD, x, d] }]) {
        const where = `${dir} ${table.slots.map((s) => s.kind).join(",")}`;
        const opened = await submit(table);
        expect(opened.roster!.slots.find((s) => s.kind === "doc"), where).toMatchObject({ status: "satisfied", via: "rule" });
        const row = reviewRow({ metadata: { source_document: { id: DOC, document_number: "P-100", rev: "2" }, review_roster: opened.roster } });
        const dry = await run(row, "q-1", { actionType: "sign_slot", dryRun: true }, table);
        expect(dry.status, `${where} ${JSON.stringify(dry.json)}`).toBe(200);
        expect(dry.json.slots, where).toEqual(["Cross check"]);
        const r = await run(row, "q-1", { actionType: "sign_slot", signatureId: SIG }, table);
        expect(r.status, `${where} ${JSON.stringify(r.json)}`).toBe(200);
        expect(r.json.status, where).toBe("PENDING_REVIEW");
        const after = (ticketUpdates()[0].args[0] as { metadata: { review_roster: TicketReviewRoster } }).metadata.review_roster;
        expect(after.slots.find((s) => s.kind === "xchk"), where).toMatchObject({ status: "satisfied", via: "primary", satisfiedBy: "q-1" });
        expect(after.slots.find((s) => s.kind === "doc"), where).toMatchObject({ status: "satisfied", via: "rule" });
        // q-1 again: the upgrade of the rule's slot conflicts with what they signed — the engine offers them
        // no sign-off, so the route refuses it (403), nothing written
        const row2 = { ...row, metadata: { ...(row.metadata as object), review_roster: after } };
        for (const dryRun of [true, false]) {
          const again = await run(row2, "q-1", { actionType: "sign_slot", signatureId: SIG, dryRun }, table);
          expect(again.status, where).toBe(403);
          expect(again.json.error, where).toMatch(/^Action "sign_slot" is not available to you/);
          expect(ticketUpdates(), where).toEqual([]);
        }
        // the live reviewer completes it
        const SIG2 = "5a000000-0000-4000-8000-000000000002";
        const done = await run(row2, "e-2", { actionType: "sign_slot", signatureId: SIG2 }, table, { extra: () => { state.rows.e_signatures = [{ ...state.rows.e_signatures[0], id: SIG2 }]; } });
        expect(done.status, `${where} ${JSON.stringify(done.json)}`).toBe(200);
        expect(done.json.status, where).toBe("PENDING_IFC");
      }
    }
  });
  it("after the re-open, the slot's reviewer signs and the request issues", async () => {
    const row = await ruledRow();
    const extra = () => { state.rows.ticket_examination_scopes = [{ ticket_id: "t1", org_id: "o1", field_values: {}, waiver: { reason: "vendor data" } }]; };
    await run(row, "e-2", { actionType: "sign_slot", signatureId: SIG }, WITH_EO, { extra });
    const reopened = (ticketUpdates()[0].args[0] as { metadata: { review_roster: TicketReviewRoster } }).metadata.review_roster;
    const row2 = { ...row, metadata: { ...(row.metadata as object), review_roster: reopened } };
    const SIG2 = "5a000000-0000-4000-8000-000000000002";
    const r = await run(row2, "q-1", { actionType: "sign_slot", signatureId: SIG2 }, WITH_EO, { extra: () => { extra(); state.rows.e_signatures = [{ ...state.rows.e_signatures[0], id: SIG2 }]; } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.status).toBe("PENDING_IFC");
  });
});
