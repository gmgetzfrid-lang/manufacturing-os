// drafting-flow Round G, DF-P7 CONSENT — the maintenance cron's ONE step
// (lib/consentWindowScan.ts runConsentWindowScan): the retry of a window the
// route could not open, the reminder (DEC-39), and the close — the
// auto-advance as a recorded SYSTEM act (audit row first, then the
// compare-and-set), written into the ticket's own history naming everyone
// asked, with the append-only notice events and the roster ledger after it.
// Plus the DEC-38 holds: no delivery record → never consent; the producer
// floor → never silence over the drafter's own sign-off.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { runConsentWindowScan, emailPreferenceReason, emailPreferenceOf, assignmentQueueOf, memberNameOf, CONSENT_EMAIL_EVENT, CONSENT_ISSUE_AS_IS_NOTE, afterRosterOpened, consentChannelNote, markConsentPlanOpened } from "@/lib/consentWindowScan";
import { ISSUE_AS_IS_NOTE } from "@/lib/workflow";
import { emailAllowedByPrefs, PREFERENCE_EXEMPT_EVENT_TYPES } from "@/lib/notificationPrefs";
import { CONSENT_WINDOW_COLUMNS, CONSENT_WARN_LEAD_MS, CONSENT_REASON, consentPlanNote } from "@/lib/consentWindow";
import type { TicketReviewRoster, TicketReviewSlot } from "@/types/schema";

type Row = Record<string, unknown>;
const db = {
  tables: {} as Record<string, Row[]>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  errors: {} as Record<string, { code?: string; message: string }>,
  rpc: {} as Record<string, { data: unknown; error: null | { code?: string; message: string } }>,
};

const pathGet = (r: Row, key: string): unknown => {
  if (!key.includes("->")) return r[key];
  const parts = key.split(/->>?/);
  let v: unknown = r[parts[0]];
  for (const p of parts.slice(1)) v = v && typeof v === "object" ? (v as Row)[p] : undefined;
  return v;
};
function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: "select" | "insert" | "update" | "delete" = "select";
  let payload: unknown = null;
  let limit = Infinity;
  const matched = () => (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const b: Record<string, unknown> = {
    select: (..._a: unknown[]) => { if (op === "select") op = "select"; db.calls.push({ table, method: "select", args: _a }); return b; },
    eq: (k: string, v: unknown) => { filters.push((r) => pathGet(r, k) === v); return b; },
    is: (k: string, v: unknown) => { filters.push((r) => (pathGet(r, k) ?? null) === v); return b; },
    not: (k: string, how: string, v: unknown) => { filters.push((r) => (how === "is" ? (pathGet(r, k) ?? null) !== v : true)); return b; },
    in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(pathGet(r, k))); return b; },
    gt: (k: string, v: string) => { filters.push((r) => String(pathGet(r, k)) > v); return b; },
    gte: (k: string, v: string) => { filters.push((r) => String(pathGet(r, k)) >= v); return b; },
    lt: (k: string, v: string) => { filters.push((r) => String(pathGet(r, k)) < v); return b; },
    order: () => b,
    limit: (n: number) => { limit = n; return b; },
    insert: (rows: unknown) => { op = "insert"; payload = rows; db.calls.push({ table, method: "insert", args: [rows] }); return b; },
    update: (patch: unknown) => { op = "update"; payload = patch; db.calls.push({ table, method: "update", args: [patch] }); return b; },
    delete: () => { op = "delete"; db.calls.push({ table, method: "delete", args: [] }); return b; },
    maybeSingle: async () => {
      if (db.errors[table]) return { data: null, error: db.errors[table] };
      return { data: matched()[0] ?? null, error: null };
    },
    then: (resolve: (v: unknown) => void) => {
      const err = db.errors[`${table}:${op}`] ?? (op === "select" ? db.errors[table] : undefined);
      if (err) return resolve({ data: null, error: err });
      if (op === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]) as Row[];
        db.tables[table] = [...(db.tables[table] ?? []), ...rows];
        return resolve({ data: null, error: null, count: rows.length });
      }
      if (op === "delete") {
        const m = new Set(matched());
        db.tables[table] = (db.tables[table] ?? []).filter((r) => !m.has(r));
        return resolve({ data: null, error: null });
      }
      if (op === "update") {
        const m = matched();
        for (const r of m) Object.assign(r, payload as Row);
        return resolve({ data: m.map((r) => ({ id: r.id })), error: null });
      }
      const rows = matched().slice(0, limit);
      return resolve({ data: rows, error: null, count: rows.length });
    },
  };
  return b;
}
const client = {
  from: (t: string) => builder(t),
  rpc: async (fn: string, args?: Record<string, unknown>) => { db.calls.push({ table: `rpc:${fn}`, method: "rpc", args: [args] }); return db.rpc[fn] ?? { data: 1, error: null }; },
};

const NOW = Date.parse("2026-10-23T03:00:00Z");
const ROSTER_ID = "11111111-1111-4111-8111-111111111111";
const slot = (over: Partial<TicketReviewSlot> & { kind: string }): TicketReviewSlot => ({
  id: `r:${over.kind}`, label: over.kind, mode: "blocking", primaries: [], alternates: [], overriders: [], independentOf: [],
  timeoutDays: null, fallback: false, status: "open", ...over,
});
const member = (uid: string, role: string) => ({ org_id: "o1", uid, role, roles: [role], email: `${uid}@x.io`, display_name: uid.toUpperCase(), status: "active" });
const COLS = Object.fromEntries(CONSENT_WINDOW_COLUMNS.map((c) => [c, null]));

function seedTicket(opts: { accept?: "signed-by-req" | "signed-by-drafter" | "open"; warned?: string | null; plan?: boolean; window?: boolean } = {}) {
  const accept = opts.accept ?? "signed-by-req";
  const acceptSlot = accept === "open"
    ? slot({ kind: "accept", label: "Acceptance", primaries: ["req"] })
    : slot({ kind: "accept", label: "Acceptance", primaries: ["req", "d-1"], status: "satisfied", satisfiedBy: accept === "signed-by-req" ? "req" : "d-1", satisfiedAt: "2026-10-19T10:00:00Z", signatureId: "s1", via: "primary" });
  const roster: TicketReviewRoster = {
    v: 1, id: ROSTER_ID, openedAt: "2026-10-19T09:00:00Z", openedBy: "d-1", level: "library", cycle: "1A", contentHash: "h", files: [],
    slots: [acceptSlot, slot({ kind: "ops", label: "Operations", mode: "consent_window", primaries: ["o-1", "o-2"], windowDays: 3, warnFraction: 2 / 3 })],
    // DEC-90 ruling (4): a window that opened has its plan marked "opened"
    // (markConsentPlanOpened); a plan still to open is "open".
    consentPlan: { kind: opts.window === false ? "open" : "opened", slot: "ops", label: "Operations", recipients: ["o-1", "o-2"], windowDays: 3, warnFraction: 2 / 3 },
    ...(opts.window === false ? {} : { consentWindow: { slot: "ops", openedAt: "2026-10-19T09:00:00Z", warnAt: "2026-10-21T09:00:00Z", closesAt: "2026-10-22T09:00:00Z", recipients: ["o-1", "o-2"], ...(opts.warned ? { warnedAt: opts.warned } : {}) } }),
  };
  const windowCols = opts.window === false ? {} : {
    consent_window_opened_at: "2026-10-19T09:00:00Z", consent_window_recipients: ["o-1", "o-2"], consent_window_slot: "ops", consent_window_roster: ROSTER_ID,
    consent_window_warn_at: "2026-10-21T09:00:00Z", consent_window_closes_at: "2026-10-22T09:00:00Z", consent_window_warned_at: opts.warned ?? null,
  };
  db.tables.tickets = [{
    id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "Gasket", status: "PENDING_REVIEW", request_type: "ISO", requester_id: "req", requester_role: "Manager",
    assigned_drafter_id: "d-1", attachments: [], comments: [], history: [], watchers: [], unread_by: [], revision_count: 0, deliverable_rev: "1A",
    last_modified: "2026-10-21T09:00:00Z", archived_at: null, library_id: LIB_ID, metadata: { review_roster: roster }, ...COLS, ...windowCols,
  }];
  // The roster ledger (ticket_review_slots — service-written), agreeing with the roster.
  db.tables.ticket_review_slots = [
    { id: "la", ticket_id: "t1", roster_id: ROSTER_ID, slot_kind: "accept", mode: "blocking", status: accept === "open" ? "open" : "satisfied", primaries: acceptSlot.primaries, independent_of: [], fallback: false },
    { id: "ls", ticket_id: "t1", roster_id: ROSTER_ID, slot_kind: "ops", mode: "consent_window", status: "open", primaries: ["o-1", "o-2"], independent_of: [], fallback: false },
  ];
}
// DEC-90 ruling (1) (merge-time fix pass): the request's EFFECTIVE routing
// table, re-read by the retry and the close — "ops" a confirmed consent slot.
const LIB_ID = "lib-1";
const CONFIRMED_ROUTING = { slots: [
  { kind: "accept", label: "Acceptance", mode: "blocking", fill: { identity: "requester" } },
  { kind: "ops", label: "Operations", mode: "consent_window", consent_confirmed: true, fill: { users: ["o-1", "o-2"] } },
] };
const ledgerOps = () => db.tables.ticket_review_slots.find((r) => r.slot_kind === "ops")!;

beforeEach(() => {
  db.tables = {
    org_members: [member("req", "Manager"), member("d-1", "Drafter"), member("o-1", "Viewer"), member("o-2", "Viewer"), member("a-1", "Admin")],
    org_configurations: [],
    ticket_notice_events: [
      { ticket_id: "t1", roster_id: ROSTER_ID, kind: "delivered", recipient: "o-1", notification_id: "n-1" },
      { ticket_id: "t1", roster_id: ROSTER_ID, kind: "delivered", recipient: "o-2", notification_id: "n-2" },
    ],
    notifications: [{ id: "n-1", read_at: "2026-10-20T10:00:00Z" }, { id: "n-2", read_at: null }],
    audit_logs: [],
    ticket_review_slots: [],
    libraries: [{ id: LIB_ID, routing_control: CONFIRMED_ROUTING }],
  };
  db.calls = []; db.errors = {}; db.rpc = {};
});
const calls = (t: string, m: string) => db.calls.filter((c) => c.table === t && c.method === m);

describe("before 20261255 — not run, said; nothing read or written", () => {
  it("a 42703 naming the column: one line, schemaReady false, no write", async () => {
    seedTicket();
    db.errors.tickets = { code: "42703", message: "column tickets.consent_window_opened_at does not exist" };
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r.schemaReady).toBe(false);
    expect(r.errors.join(" ")).toMatch(/not run — consent windows start when 20261255 is pasted/);
    expect(calls("tickets", "update")).toEqual([]);
    expect(db.calls.some((c) => c.table.startsWith("rpc:"))).toBe(false);
  });
});

describe("DEC-39 — the reminder at the configured fraction, to the people asked and the assignment queue", () => {
  it("past warn_at and not yet reminded: record_consent_window_warning with everyone asked plus the queue; no close", async () => {
    seedTicket({ warned: null });
    const r = await runConsentWindowScan({ client, now: Date.parse("2026-10-21T10:00:00Z") });
    expect(r.warned).toBe(1);
    const w = calls("rpc:record_consent_window_warning", "rpc")[0].args[0] as Record<string, unknown>;
    expect(w.p_recipients).toEqual(expect.arrayContaining(["o-1", "o-2", "a-1"]));
    expect(w.p_roster).toBe(ROSTER_ID);
    expect((w.p_history as { action: string }).action).toBe("Consent window reminder — Operations");
    expect(calls("tickets", "update")).toEqual([]);
    expect(calls("audit_logs", "insert")).toEqual([]);
  });
  it("a reminder the database refuses is a line, and the window cannot close", async () => {
    seedTicket({ warned: null });
    db.rpc.record_consent_window_warning = { data: null, error: { code: "P0001", message: "not every person could be reminded" } };
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r.failed).toBe(1);
    expect(r.errors.join(" ")).toMatch(/reminder was not sent, so the window cannot close yet/);
    expect(calls("tickets", "update")).toEqual([]);
  });
});

describe("the close — advanced without objection, a recorded system act", () => {
  it("the last blocking slot: audit row FIRST, then the CAS (status, expiry, history naming everyone asked), then the notice events and the ledger", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ advanced: 1, issued: 1, held: 0, failed: 0 });
    const order = db.calls.filter((c) => (c.table === "audit_logs" && c.method === "insert") || (c.table === "tickets" && c.method === "update")).map((c) => c.table);
    expect(order).toEqual(["audit_logs", "tickets"]);
    const audit = calls("audit_logs", "insert")[0].args[0] as Row;
    expect(audit).toMatchObject({ action: "TICKET_CONSENT_WINDOW_ADVANCE", user_id: null, user_email: "system:consent-window", user_role: "system" });
    expect((audit.details as Row).asked).toEqual([
      expect.objectContaining({ uid: "o-1", name: "O-1", notice: "opened" }), expect.objectContaining({ uid: "o-2", name: "O-2", notice: "unopened" }),
    ]);
    const t = db.tables.tickets[0];
    expect(t.status).toBe("PENDING_IFC");
    expect(t.consent_window_expired_at).toBe(new Date(NOW).toISOString());
    const h = (t.history as Array<{ action: string; details: string; user: string }>).at(-1)!;
    expect(h.action).toMatch(/^Advanced without objection — Operations \(Rev 1A\) — every sign-off is in; issued Rev 1/);
    expect(h.user).toBe("system:consent-window");
    expect(h.details).toMatch(/Asked O-1, O-2 on 2026-10-19 09:00 UTC; reminded 2026-10-21 09:00 UTC; the window closed 2026-10-23 03:00 UTC/);
    expect(h.details).toMatch(/Seen, no objection: O-1 \(opened 2026-10-20 10:00 UTC\)\. Told, not opened: O-2\./);
    expect(h.details).not.toMatch(/notification/i);
    const ev = db.tables.ticket_notice_events.filter((e) => e.kind === "expired" || e.kind === "advanced");
    expect(ev.map((e) => `${e.kind}:${e.recipient ?? "-"}`)).toEqual(["expired:o-1", "expired:o-2", "advanced:-"]);
    expect(ledgerOps()).toMatchObject({ status: "satisfied", satisfied_via: "consent", satisfied_by: null, signature_id: null });
    // the people with a stake are told on the bell
    expect(calls("notifications", "insert").length).toBe(1);
  });
  it("GAP-113 acceptance 4: the people asked changed role mid-window — they are still the ones shown as asked (frozen at open, never re-resolved)", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    db.tables.org_members = db.tables.org_members.map((m) => (m.uid === "o-1" ? member("o-1", "Admin") : m.uid === "o-2" ? member("o-2", "Drafter") : m));
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ advanced: 1, held: 0 });
    const audit = calls("audit_logs", "insert")[0].args[0] as Row;
    expect(((audit.details as Row).asked as Row[]).map((a) => a.uid)).toEqual(["o-1", "o-2"]);
    expect((db.tables.tickets[0].history as Array<{ details: string }>).at(-1)!.details).toMatch(/Asked O-1, O-2 on 2026-10-19 09:00 UTC/);
  });
  it("other sign-offs still open: the window's slot is satisfied, the status does not move", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z", accept: "open" });
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ advanced: 1, issued: 0 });
    expect(db.tables.tickets[0].status).toBe("PENDING_REVIEW");
  });
  it("DEC-38: a person asked with NO delivery record was never asked — the window closes HELD, the slot waits for a sign-off", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    db.tables.ticket_notice_events = db.tables.ticket_notice_events.filter((e) => e.recipient !== "o-2");
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ advanced: 0, held: 1, issued: 0 });
    const t = db.tables.tickets[0];
    expect(t.status).toBe("PENDING_REVIEW");
    const rr = (t.metadata as { review_roster: TicketReviewRoster }).review_roster;
    expect(rr.slots.find((s) => s.kind === "ops")!.status).toBe("open");
    expect((t.history as Array<{ details: string }>).at(-1)!.details).toMatch(/No delivery is on record for O-2, so this is not consent/);
    // the headline names the delivery reason, never the drafter floor (review minor)
    const action = (t.history as Array<{ action: string }>).at(-1)!.action;
    expect(action).toMatch(/not everyone asked has a delivery on record/);
    expect(action).not.toMatch(/drafter/);
    expect(((calls("audit_logs", "insert")[0].args[0] as Row).details as Row).holdReason).toBe("undelivered");
    expect(ledgerOps().status).toBe("open");
  });
  it("DEC-12 floor: the drafter signed every other sign-off — silence is not a second person, so the close is HELD", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z", accept: "signed-by-drafter" });
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ held: 1, issued: 0 });
    expect(db.tables.tickets[0].status).toBe("PENDING_REVIEW");
    expect((db.tables.tickets[0].history as Array<{ action: string }>).at(-1)!.action).toMatch(/someone other than the drafter/);
  });
  it("DEC-12 (review blocker): a window whose only person asked is the drafter (a stale or forged plan) never issues — HELD, nobody but the drafter was asked", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    const t = db.tables.tickets[0];
    t.consent_window_recipients = ["d-1"];
    db.tables.ticket_notice_events = [{ ticket_id: "t1", roster_id: ROSTER_ID, kind: "delivered", recipient: "d-1", notification_id: "n-1" }];
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ advanced: 0, held: 1, issued: 0 });
    expect(t.status).toBe("PENDING_REVIEW");
    expect((t.history as Array<{ details: string }>).at(-1)!.details).toMatch(/Nobody but the drafter was asked/);
    expect(ledgerOps().status).toBe("open");
  });
  it("not before its warning has been out a full lead (DEC-39)", async () => {
    seedTicket({ warned: new Date(NOW - CONSENT_WARN_LEAD_MS + 60_000).toISOString() });
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r.advanced + r.held).toBe(0);
    expect(calls("tickets", "update")).toEqual([]);
  });
  it("the audit row cannot be written: nothing is closed (retried next run)", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    db.errors["audit_logs:insert"] = { code: "08006", message: "connection lost" };
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r.failed).toBe(1);
    expect(calls("tickets", "update")).toEqual([]);
    expect(db.tables.tickets[0].status).toBe("PENDING_REVIEW");
  });
  it("the request changed first (an objection landed): the CAS misses, a NOT_APPLIED row names the attempt, nothing else is written", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    // the objection lands between the read and the write: change last_modified under the scan
    const original = client.from;
    let reads = 0;
    client.from = (t: string) => {
      const b = original(t) as Record<string, (...a: unknown[]) => unknown>;
      if (t === "tickets") {
        const upd = b.update as (p: unknown) => unknown;
        b.update = (p: unknown) => { if (reads++ === 0) db.tables.tickets[0].last_modified = "2026-10-22T08:00:00Z"; return upd(p); };
      }
      return b;
    };
    try {
      const r = await runConsentWindowScan({ client, now: NOW });
      expect(r.failed).toBe(1);
      expect(r.errors.join(" ")).toMatch(/the window was not closed — the request changed first/);
      const actions = calls("audit_logs", "insert").map((c) => (c.args[0] as Row).action);
      expect(actions).toEqual(["TICKET_CONSENT_WINDOW_ADVANCE", "TICKET_CONSENT_WINDOW_ADVANCE_NOT_APPLIED"]);
      expect(db.tables.tickets[0].status).toBe("PENDING_REVIEW");
      expect(db.tables.ticket_notice_events.some((e) => e.kind === "advanced")).toBe(false);
    } finally {
      client.from = original;
    }
  });
});

describe("HAND-7 parity (review major): an issuing close runs the source-revision check first", () => {
  const SRC = "22222222-2222-4222-8222-222222222222";
  const withSource = () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    const t = db.tables.tickets[0];
    t.metadata = { ...(t.metadata as Row), source_document: { id: SRC, document_number: "PID-100", rev: "B" } };
  };
  it("the source moved (Rev B → Rev C): HELD for a person — not issued, the history and the audit row say what moved", async () => {
    withSource();
    db.tables.documents = [{ id: SRC, org_id: "o1", rev: "C", current_version_id: null, document_number: "PID-100" }];
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ advanced: 0, held: 1, issued: 0 });
    const t = db.tables.tickets[0];
    expect(t.status).toBe("PENDING_REVIEW");
    const h = (t.history as Array<{ action: string; details: string }>).at(-1)!;
    expect(h.action).toMatch(/a source document moved/);
    expect(h.details).toMatch(/PID-100 raised on Rev B, now Rev C/);
    const d = (calls("audit_logs", "insert")[0].args[0] as Row).details as Row;
    expect(d).toMatchObject({ holdReason: "source_moved", sourceDrift: { moved: ["PID-100 raised on Rev B, now Rev C"], acknowledged: false } });
    expect(ledgerOps().status).toBe("open");
  });
  it("the source cannot be read: HELD (never issued unchecked); the audit row records sourceDriftUnchecked", async () => {
    withSource();
    // The source-revision read fails (the routing re-read — DEC-90 ruling
    // (1) — locates the source document with its own single-row read first).
    db.errors["documents:select"] = { code: "08006", message: "connection lost" };
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ held: 1, issued: 0 });
    const d = (calls("audit_logs", "insert")[0].args[0] as Row).details as Row;
    expect(d).toMatchObject({ holdReason: "source_unchecked", sourceDriftUnchecked: true });
    expect(db.tables.tickets[0].status).toBe("PENDING_REVIEW");
  });
  it("the source has not moved: issued as before", async () => {
    withSource();
    db.tables.documents = [{ id: SRC, org_id: "o1", rev: "B", current_version_id: null, document_number: "PID-100" }];
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ advanced: 1, issued: 1 });
    expect(db.tables.tickets[0].status).toBe("PENDING_IFC");
  });
  it("a close that does not issue (other sign-offs open) does not read the sources", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z", accept: "open" });
    db.errors.documents = { code: "08006", message: "connection lost" };
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ advanced: 1, issued: 0, held: 0 });
    expect(calls("documents", "select")).toEqual([]);
  });
});

describe("the ledger is the authority (review major): a forged metadata roster cannot close, complete or open a window", () => {
  it("the window's slot is not an open consent slot in the ledger: not closed, a line", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    db.tables.ticket_review_slots = db.tables.ticket_review_slots.filter((r) => r.slot_kind !== "ops");
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ advanced: 0, held: 0, failed: 1 });
    expect(r.errors.join(" ")).toMatch(/ledger does not show "Operations" as an open consent slot/);
    expect(calls("tickets", "update")).toEqual([]);
    expect(calls("audit_logs", "insert")).toEqual([]);
  });
  it("metadata says every other sign-off is in but the ledger does not: HELD (record_mismatch), never issued", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    db.tables.ticket_review_slots.find((r) => r.slot_kind === "accept")!.status = "open";
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ held: 1, issued: 0 });
    expect(db.tables.tickets[0].status).toBe("PENDING_REVIEW");
    expect(((calls("audit_logs", "insert")[0].args[0] as Row).details as Row).holdReason).toBe("record_mismatch");
  });
  it("the ledger cannot be read: nothing is closed (retried next run)", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    db.errors.ticket_review_slots = { code: "08006", message: "connection lost" };
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r.failed).toBe(1);
    expect(calls("tickets", "update")).toEqual([]);
  });
});

describe("the read cap (review minor): stale windows are retired; each run starts from a random point", () => {
  it("a running window whose slot a person signed is retired (its expiry stamped) and never closed", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    const t = db.tables.tickets[0];
    const rr = (t.metadata as { review_roster: TicketReviewRoster }).review_roster;
    rr.slots = rr.slots.map((x) => (x.kind === "ops" ? { ...x, status: "satisfied", satisfiedBy: "o-1", satisfiedAt: "2026-10-20T00:00:00Z", signatureId: "s2", via: "primary" } : x));
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ retired: 1, advanced: 0, held: 0 });
    expect(t.consent_window_expired_at).toBe(new Date(NOW).toISOString());
    expect(t.status).toBe("PENDING_REVIEW");
    expect(calls("audit_logs", "insert")).toEqual([]);
    // the next run no longer reads it as running
    db.calls = [];
    const again = await runConsentWindowScan({ client, now: NOW + 60_000 });
    expect(again.retired).toBe(0);
  });
  it("a window left over from a replaced review (no consent slot on the new one) is retired", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    const t = db.tables.tickets[0];
    const rr = (t.metadata as { review_roster: TicketReviewRoster }).review_roster;
    t.metadata = { review_roster: { ...rr, id: "33333333-3333-4333-8333-333333333333", consentPlan: null, consentWindow: null, slots: [rr.slots[0]] } };
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r.retired).toBe(1);
    expect(t.consent_window_expired_at).toBe(new Date(NOW).toISOString());
  });
  it("rows on both sides of the pivot are read; past the cap the run says truncated", async () => {
    seedTicket({ warned: null });
    const t1 = db.tables.tickets[0];
    db.tables.tickets.push({ ...structuredClone(t1), id: "t0" });
    // before the reminder is due: each row is read, nothing changes
    const early = Date.parse("2026-10-20T00:00:00Z");
    const r = await runConsentWindowScan({ client, now: early, pivot: "t1", maxTickets: 1 });
    expect(r.truncated).toBe(true);
    expect(r.scanned).toBe(1);
    // with room for both, the row before the pivot is read too (wrapped round)
    db.calls = [];
    const r2 = await runConsentWindowScan({ client, now: early, pivot: "t1", maxTickets: 5 });
    expect(r2.scanned).toBe(2);
    expect(r2.truncated).toBe(false);
  });
});

describe("the retry — a window the route could not open", () => {
  it("planned, not open: open_consent_window is called again with the frozen recipients", async () => {
    seedTicket({ window: false });
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r.opened).toBe(1);
    const call = calls("rpc:open_consent_window", "rpc")[0].args[0] as Row;
    expect(call).toMatchObject({ p_ticket: "t1", p_roster: ROSTER_ID, p_slot: "ops", p_recipients: ["o-1", "o-2"] });
  });
  it("asks only who the LEDGER's slot names, never the drafter — a plan naming the drafter (stale or forged) drops them", async () => {
    seedTicket({ window: false });
    const rr = (db.tables.tickets[0].metadata as { review_roster: TicketReviewRoster }).review_roster;
    rr.consentPlan = { kind: "open", slot: "ops", label: "Operations", recipients: ["d-1", "o-1", "x-forged"], windowDays: 3, warnFraction: 2 / 3 };
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r.opened).toBe(1);
    expect((calls("rpc:open_consent_window", "rpc")[0].args[0] as Row).p_recipients).toEqual(["o-1"]);
  });
  it("nobody left to ask, or no open consent slot in the ledger: no call, a line", async () => {
    seedTicket({ window: false });
    const rr = (db.tables.tickets[0].metadata as { review_roster: TicketReviewRoster }).review_roster;
    rr.consentPlan = { kind: "open", slot: "ops", label: "Operations", recipients: ["d-1"], windowDays: 3, warnFraction: 2 / 3 };
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ opened: 0, failed: 1 });
    expect(calls("rpc:open_consent_window", "rpc")).toEqual([]);
    seedTicket({ window: false });
    db.tables.ticket_review_slots = [];
    db.calls = [];
    const r2 = await runConsentWindowScan({ client, now: NOW });
    expect(r2.opened).toBe(0);
    expect(r2.errors.join(" ")).toMatch(/ledger does not show "Operations" as an open consent slot/);
    expect(calls("rpc:open_consent_window", "rpc")).toEqual([]);
  });
  it("refused again for a reason a retry may change (a transient code): a line, nothing else (the slot waits for a sign-off)", async () => {
    seedTicket({ window: false });
    for (const code of ["40001", "57014", "P0001", undefined]) {
      db.calls = [];
      db.rpc.open_consent_window = { data: null, error: { ...(code ? { code } : {}), message: "try again" } };
      const r = await runConsentWindowScan({ client, now: NOW });
      expect(r.failed, String(code)).toBe(1);
      expect(calls("tickets", "update")).toEqual([]);
    }
  });
  it("fix pass 3: refused for good (22023 / 55000 / 23505) — the plan is marked blocked ONCE, the queue told once, and it is never retried", async () => {
    for (const code of ["22023", "55000", "23505"]) {
      seedTicket({ window: false });
      db.tables.ticket_notice_events = [];
      db.calls = [];
      db.rpc.open_consent_window = { data: null, error: { code, message: `refused ${code}` } };
      const r = await runConsentWindowScan({ client, now: NOW });
      expect(r.failed, code).toBe(1);
      expect(r.errors.join(" ")).toMatch(/refused for good .* it is not tried again/);
      const rr = (db.tables.tickets[0].metadata as { review_roster: TicketReviewRoster }).review_roster;
      expect(rr.consentPlan).toMatchObject({ kind: "blocked", slot: "ops" });
      expect((rr.consentPlan as { reason: string }).reason).toMatch(new RegExp(`refused ${code}`));
      expect(db.tables.ticket_notice_events).toEqual([expect.objectContaining({ kind: "blocked", details: expect.objectContaining({ reason: "window_never_opened", refusal: { code, error: `refused ${code}` } }) })]);
      expect(calls("notifications", "insert").length).toBe(1);
      // the next run does not read it again
      db.calls = [];
      const again = await runConsentWindowScan({ client, now: NOW });
      expect(again).toMatchObject({ scanned: 0, failed: 0 });
      expect(calls("rpc:open_consent_window", "rpc")).toEqual([]);
    }
  });
});

describe("helpers", () => {
  it("emailPreferenceReason names the person's own choice, and nothing when email is on", () => {
    expect(emailPreferenceReason({ email_enabled: false }, "ticket_status_changed")).toBe("they turned email off");
    expect(emailPreferenceReason({ digest_frequency: "never" }, "assignment")).toBe("they set email delivery to never");
    expect(emailPreferenceReason({ email_on_assignment: false }, "assignment")).toBe("they turned assignment emails off");
    expect(emailPreferenceReason({ email_on_status_change: false }, "ticket_approved")).toBe("they turned status-change emails off");
    expect(emailPreferenceReason({}, "ticket_closed")).toBeNull();
    expect(emailPreferenceReason(undefined, "ticket_closed")).toBeNull();
  });
  it("the assignment queue is whoever ticket.assign names; a member's name is their display name", () => {
    const members = [member("a-1", "Admin"), member("v-1", "Viewer")];
    expect(assignmentQueueOf({ members, policy: null, resource: null, requesterId: null })).toEqual(["a-1"]);
    expect(memberNameOf(members)("a-1")).toBe("A-1");
    expect(memberNameOf(members)("zzzzzzzz-gone")).toBe("member zzzzzzzz");
  });
});

// ── DF-P7 fix pass 2 ────────────────────────────────────────────────────────
const lastHistory = () => (db.tables.tickets[0].history as Array<{ action: string; details: string }>).at(-1)!;
const auditDetails = () => (calls("audit_logs", "insert")[0].args[0] as Row).details as Row;
const rosterOf = () => (db.tables.tickets[0].metadata as { review_roster: TicketReviewRoster }).review_roster;
/** The window's slot declares itself independent of the acceptance slot, in
 *  the roster AND the ledger; who signed the acceptance is `signer`. */
function independentOfAccept(signer: string) {
  const rr = rosterOf();
  rr.slots = rr.slots.map((x) => (x.kind === "ops" ? { ...x, independentOf: ["accept"] } : x.kind === "accept" ? { ...x, primaries: [signer, "req"], satisfiedBy: signer } : x));
  ledgerOps().independent_of = ["accept"];
  const la = db.tables.ticket_review_slots.find((r) => r.slot_kind === "accept")!;
  la.satisfied_by = signer;
  la.satisfied_via = "primary";
}

describe("DEC-37 slot-to-slot at the close (review major 1): the silence of the person who signed the other slot is never the second look", () => {
  it("the only person told signed the slot the window's slot must be independent of: HELD ('independence'), never issued", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    independentOfAccept("o-1");
    db.tables.tickets[0].consent_window_recipients = ["o-1"];
    db.tables.ticket_notice_events = db.tables.ticket_notice_events.filter((e) => e.recipient === "o-1");
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ advanced: 0, held: 1, issued: 0 });
    expect(db.tables.tickets[0].status).toBe("PENDING_REVIEW");
    expect(lastHistory().action).toMatch(/must be independent of, so their silence is not a second look/);
    expect(lastHistory().details).toMatch(/Everyone told also signs, or can sign, a sign-off "Operations" must be independent of \(O-1\)/);
    expect(auditDetails()).toMatchObject({ holdReason: "independence", independence: { conflicted: ["o-1"] } });
    expect(ledgerOps().status).toBe("open");
  });
  it("read from the LEDGER alone (the roster says nothing): the acceptance row declares itself independent of the window's slot — still HELD", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    db.tables.tickets[0].consent_window_recipients = ["o-1"];
    db.tables.ticket_notice_events = db.tables.ticket_notice_events.filter((e) => e.recipient === "o-1");
    const la = db.tables.ticket_review_slots.find((r) => r.slot_kind === "accept")!;
    Object.assign(la, { satisfied_by: "o-1", satisfied_via: "primary", independent_of: ["ops"] });
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ held: 1, issued: 0 });
    expect(auditDetails().holdReason).toBe("independence");
  });
  it("someone independent was told too: advances as before (O-2 had the window to object)", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    independentOfAccept("o-1");
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ advanced: 1, issued: 1, held: 0 });
  });
});

describe("the two floors agree (review major 2): a silent close never strands a slot only the drafter can sign", () => {
  it("an open slot only the drafter occupies, separation of duties active: HELD (producer floor), the history names the slot", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z", accept: "open" });
    const rr = rosterOf();
    rr.slots = rr.slots.map((x) => (x.kind === "accept" ? { ...x, primaries: ["d-1"] } : x));
    db.tables.ticket_review_slots.find((r) => r.slot_kind === "accept")!.primaries = ["d-1"];
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ advanced: 0, held: 1 });
    expect(lastHistory().details).toMatch(/"Acceptance" can be signed only by the drafter/);
    expect(auditDetails()).toMatchObject({ holdReason: "producer_floor", producerFloor: true });
    expect(rosterOf().slots.find((x) => x.kind === "ops")!.status).toBe("open");
  });
  it("REGRESSION: the open slot has someone else in it — the close advances (the review waits on that slot)", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z", accept: "open" });
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ advanced: 1, held: 0, issued: 0 });
  });
});

describe("the retry (review minor): only active members are asked; nobody left records the block once and stops", () => {
  it("one of the two left the org: the window opens asking the one who is still a member", async () => {
    seedTicket({ window: false });
    db.tables.org_members = db.tables.org_members.filter((m) => m.uid !== "o-2");
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r.opened).toBe(1);
    expect((calls("rpc:open_consent_window", "rpc")[0].args[0] as Row).p_recipients).toEqual(["o-1"]);
  });
  it("DEC-37 on the retry: someone who signed a slot the window's slot is independent of is not asked", async () => {
    seedTicket({ window: false });
    independentOfAccept("o-1");
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r.opened).toBe(1);
    expect((calls("rpc:open_consent_window", "rpc")[0].args[0] as Row).p_recipients).toEqual(["o-2"]);
  });
  it("both left: no call; the plan is marked blocked on the roster (CAS), a 'blocked' notice event is written, the assignment queue told — and the next run does nothing", async () => {
    seedTicket({ window: false });
    db.tables.org_members = db.tables.org_members.filter((m) => m.uid !== "o-1" && m.uid !== "o-2");
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ opened: 0, failed: 1 });
    expect(calls("rpc:open_consent_window", "rpc")).toEqual([]);
    expect(rosterOf().consentPlan).toMatchObject({ kind: "blocked", slot: "ops" });
    expect(db.tables.tickets[0].last_modified).toBe(new Date(NOW).toISOString());
    expect(db.tables.ticket_notice_events.filter((e) => e.kind === "blocked")).toEqual([
      expect.objectContaining({ slot_kind: "ops", details: expect.objectContaining({ reason: "window_never_opened", escalatedTo: ["a-1", "req"] }) }),
    ]);
    const bell = calls("notifications", "insert").flatMap((c) => c.args[0] as Row[]);
    // the assignment queue (ticket.assign: the Admin and the Manager here)
    expect(bell.map((n) => n.user_id).sort()).toEqual(["a-1", "req"]);
    expect(r.errors.join(" ")).toMatch(/nobody "Operations" names may still be asked/);
    db.calls = [];
    const again = await runConsentWindowScan({ client, now: NOW + 3_600_000 });
    expect(again).toMatchObject({ scanned: 0, failed: 0 });
    expect(calls("notifications", "insert")).toEqual([]);
  });
});

describe("the reminder's assigner is resolved for THIS request (review minor)", () => {
  it("a ticket.assign rule scoped to the request type names the queue the reminder adds", async () => {
    seedTicket({ warned: null });
    db.tables.org_configurations = [{ org_id: "o1", key: "capability_policy", data: { caps: { "ticket.assign": [{ tokens: ["Drafter"], when: { requestType: ["ISO"] } }, { tokens: ["Admin"] }] } }, updated_at: null }];
    const r = await runConsentWindowScan({ client, now: Date.parse("2026-10-21T10:00:00Z") });
    expect(r.warned).toBe(1);
    const w = calls("rpc:record_consent_window_warning", "rpc")[0].args[0] as Row;
    expect(w.p_recipients).toEqual(["o-1", "o-2", "d-1"]);
  });
});

describe("EVID-9 / DEC-38 for the window itself (review major 4): its notices are emailed, each channel is named, and a person not emailed is recorded", () => {
  it("the reminder: emailed to everyone whose preferences allow it (as an assignment email, absolute link); a person with email off gets a not_emailed record; the history names each channel", async () => {
    seedTicket({ warned: null });
    db.tables.notification_preferences = [{ user_id: "o-2", email_enabled: false }];
    db.tables.orgs = [{ id: "o1", name: "Acme" }];
    const r = await runConsentWindowScan({ client, now: Date.parse("2026-10-21T10:00:00Z"), origin: "https://app.example.com" });
    expect(r.warned).toBe(1);
    const mails = calls("email_notifications", "insert").flatMap((c) => c.args[0] as Row[]);
    expect(mails.map((m) => m.to_user_id).sort()).toEqual(["a-1", "o-1", "req"]);
    expect(mails[0]).toMatchObject({ event_type: CONSENT_EMAIL_EVENT, resource_id: "t1", status: "queued", metadata: expect.objectContaining({ action: "consent_window_warned" }) });
    expect(String(mails[0].body_text)).toContain("https://app.example.com/requests/t1");
    const ne = db.tables.ticket_notice_events.filter((e) => e.kind === "not_emailed");
    expect(ne).toEqual([expect.objectContaining({ recipient: "o-2", roster_id: ROSTER_ID, slot_kind: "ops", details: expect.objectContaining({ reason: "they turned email off", byTheirChoice: true, action: "consent_window_warned" }) })]);
    const hist = (calls("rpc:record_consent_window_warning", "rpc")[0].args[0] as { p_history: { details: string } }).p_history.details;
    // DEC-90 ruling (2): the history names the channel only — the reason a
    // preference gives stays in O-2's own not_emailed row (above).
    expect(hist).toMatch(/Each was told in the app; by email as well: O-1, (A-1, REQ|REQ, A-1); in the app only: O-2\./);
    expect(hist).not.toMatch(/turned|preference/);
  });
  it("the open (the retry): the people asked are emailed after the RPC lands, and its history line names the channel", async () => {
    seedTicket({ window: false });
    const r = await runConsentWindowScan({ client, now: NOW, origin: "https://app.example.com" });
    expect(r.opened).toBe(1);
    const order = db.calls.filter((c) => c.table === "rpc:open_consent_window" || (c.table === "email_notifications" && c.method === "insert")).map((c) => c.table);
    expect(order).toEqual(["rpc:open_consent_window", "email_notifications"]);
    const mails = calls("email_notifications", "insert").flatMap((c) => c.args[0] as Row[]);
    expect(mails.map((m) => m.to_user_id)).toEqual(["o-1", "o-2"]);
    expect(mails[0].metadata).toMatchObject({ action: "consent_window_opened", consentWindow: { roster: ROSTER_ID, slot: "ops" } });
    expect(((calls("rpc:open_consent_window", "rpc")[0].args[0] as { p_history: { details: string } }).p_history.details)).toMatch(/Each was told in the app; by email as well: O-1, O-2\./);
  });
  it("the RPC refuses: nothing is emailed (no notice, no email)", async () => {
    seedTicket({ window: false });
    db.rpc.open_consent_window = { data: null, error: { code: "P0001", message: "not every person asked could be told" } };
    await runConsentWindowScan({ client, now: NOW });
    expect(calls("email_notifications", "insert")).toEqual([]);
  });
  it("the email queue refuses: each person is recorded not emailed (not by their choice), and the run says so", async () => {
    seedTicket({ warned: null });
    db.errors["email_notifications:insert"] = { code: "08006", message: "connection lost" };
    const r = await runConsentWindowScan({ client, now: Date.parse("2026-10-21T10:00:00Z") });
    expect(r.warned).toBe(1);
    expect(r.errors.join(" ")).toMatch(/the reminder went out in the app, but the emails were not queued: connection lost/);
    const ne = db.tables.ticket_notice_events.filter((e) => e.kind === "not_emailed");
    expect(ne.map((e) => e.recipient).sort()).toEqual(["a-1", "o-1", "o-2", "req"]);
    expect(ne.every((e) => (e.details as Row).byTheirChoice === false)).toBe(true);
  });
  it("the preferences cannot be read: nobody is emailed (it cannot tell who opted out), each recorded, the reminder still goes out", async () => {
    seedTicket({ warned: null });
    db.errors.notification_preferences = { code: "08006", message: "connection lost" };
    const r = await runConsentWindowScan({ client, now: Date.parse("2026-10-21T10:00:00Z") });
    expect(r.warned).toBe(1);
    expect(calls("email_notifications", "insert")).toEqual([]);
    expect(db.tables.ticket_notice_events.filter((e) => e.kind === "not_emailed").length).toBe(4);
  });
});

describe("issue-path parity (review minor): an issuing close tells the routed pool and clears the intents as the route does", () => {
  it("PENDING_IFC: the issue queue (the Admin pool) joins unread_by and the bell", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ issued: 1 });
    const t = db.tables.tickets[0];
    expect(t.status).toBe("PENDING_IFC");
    expect(t.unread_by as string[]).toContain("a-1");
    const bell = calls("notifications", "insert").flatMap((c) => c.args[0] as Row[]);
    expect(bell.map((n) => n.user_id)).toContain("a-1");
  });
  it("issue-as-is lands at FINAL_DRAFT: the request's ticket-sourced document intents are cleared (others kept)", async () => {
    const SRC = "22222222-2222-4222-8222-222222222222";
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    const t = db.tables.tickets[0];
    t.metadata = { ...(t.metadata as Row), source_document: { id: SRC, document_number: "PID-100", rev: "B" }, issue_ready: { rev: "1A", at: "2026-10-19T08:00:00.000Z" } };
    // fix pass 3: the window's opening notice named the mark
    t.history = [{ action: "Consent window opened — Operations", user: "system:consent-window", date: "2026-10-19T09:00:00Z", details: "…", consentIssueAsIs: { rev: "1A", at: "2026-10-19T08:00:00.000Z" } }];
    t.attachments = [{ id: "a-d", name: "x.pdf", url: "orgs/o1/x.pdf", type: "Draft", rev: "1A", status: "submitted" }];
    db.tables.documents = [{ id: SRC, org_id: "o1", rev: "B", current_version_id: null, document_number: "PID-100" }];
    db.tables.document_intents = [
      { document_id: SRC, ticket_id: "t1", source: "ticket", user_id: "d-1" },
      { document_id: SRC, ticket_id: "t9", source: "ticket", user_id: "d-2" },
    ];
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ issued: 1 });
    expect(t.status).toBe("FINAL_DRAFT");
    expect(db.tables.document_intents).toEqual([expect.objectContaining({ ticket_id: "t9" })]);
  });
});

describe("EVID-9 (review minor): ONE rule for 'emailed?' and 'why not'", () => {
  const TYPES = ["assignment", "engineer_review_requested", "ticket_status_changed", "ticket_approved", "ticket_revision_requested", "ticket_closed",
    "comment_mention", "watcher_activity", "sla_warning", "system", "compliance_digest", ...PREFERENCE_EXEMPT_EVENT_TYPES];
  const PREFS: Array<Record<string, unknown> | undefined> = [
    undefined, {}, { email_enabled: false }, { digest_frequency: "never" }, { email_on_assignment: false }, { email_on_status_change: false },
    { email_on_mention: false }, { email_on_watched_activity: false }, { email_on_sla_warning: false }, { email_enabled: true, email_on_assignment: true },
  ];
  it("for every event type and preference row: `wants` is lib/notificationPrefs.ts emailAllowedByPrefs, and a reason is given exactly when it does not", () => {
    for (const t of TYPES) for (const p of PREFS) {
      const d = emailPreferenceOf(p, t);
      expect(d.wants, `${t} ${JSON.stringify(p)}`).toBe(emailAllowedByPrefs(p ?? null, t));
      expect(d.reason === null, `${t} ${JSON.stringify(p)}`).toBe(d.wants);
      expect(emailPreferenceReason(p, t)).toBe(d.reason);
    }
  });
  it("the route reads it for both the email and the not-emailed record (no hand copy of the switch left there)", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync("app/api/tickets/workflow-action/route.ts", "utf8");
    expect(route).toContain("const wantsEmail = (uid: string): boolean => emailPreferenceOf(prefByUid.get(uid), cls.eventType).wants;");
    expect(route).toContain(".map((uid) => ({ uid, reason: emailByUid.has(uid) ? emailPreferenceOf(prefByUid.get(uid), cls.eventType).reason : null }))");
    expect(route).not.toContain("case \"engineer_review_requested\":");
    expect(route).not.toContain("their email preferences\" }");
  });
});

// ── DF-P7 fix pass 3 ────────────────────────────────────────────────────────
describe("fix pass 3 — the close counts only people still active members", () => {
  it("every person told was suspended or removed: HELD ('no_longer_member') — a block recorded, the assignment queue told; nothing issues", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    db.tables.org_members = db.tables.org_members.filter((m) => m.uid !== "o-1" && m.uid !== "o-2");
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ held: 1, advanced: 0, issued: 0 });
    const t = db.tables.tickets[0];
    expect(t.status).toBe("PENDING_REVIEW");
    const rr = (t.metadata as { review_roster: TicketReviewRoster }).review_roster;
    expect(rr.consentWindow).toMatchObject({ heldReason: "no_longer_member" });
    expect(rr.slots.find((s) => s.kind === "ops")).toMatchObject({ status: "open" });
    expect(lastHistory().action).toMatch(/nobody told who could have objected is still an active member/);
    expect(lastHistory().details).toMatch(/No longer an active member, so their silence is not counted: member o-1, member o-2\./);
    expect(auditDetails()).toMatchObject({ holdReason: "no_longer_member", noLongerMembers: ["o-1", "o-2"] });
    expect(db.tables.ticket_notice_events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "blocked", details: expect.objectContaining({ reason: "no_longer_member", escalatedTo: expect.arrayContaining(["a-1"]) }) }),
    ]));
    const bells = (calls("notifications", "insert")[0].args[0] as Row[]).map((n) => n.user_id);
    expect(bells).toEqual(expect.arrayContaining(["a-1"]));
    expect(bells).not.toContain("o-1");
    expect(ledgerOps()).toMatchObject({ status: "open" });
  });
  it("one of two told left: the other's silence still counts — it advances, and the record names who was not counted", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    db.tables.org_members = db.tables.org_members.filter((m) => m.uid !== "o-2");
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ advanced: 1, issued: 1, held: 0 });
    expect(lastHistory().details).toMatch(/No longer an active member, so their silence is not counted: member o-2\./);
    expect(auditDetails()).toMatchObject({ noLongerMembers: ["o-2"] });
  });
  it("the only active person told is one a slot must be independent of: held as 'no_longer_member' (independence over the people left)", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z", accept: "open" });
    // o-1 can still sign "accept", which "ops" must be independent of; o-2 left.
    const rr = (db.tables.tickets[0].metadata as { review_roster: TicketReviewRoster }).review_roster;
    rr.slots = rr.slots.map((s) => (s.kind === "accept" ? { ...s, primaries: ["req", "o-1"] } : s.kind === "ops" ? { ...s, independentOf: ["accept"] } : s));
    db.tables.ticket_review_slots = db.tables.ticket_review_slots.map((l) => (l.slot_kind === "accept" ? { ...l, primaries: ["req", "o-1"] } : { ...l, independent_of: ["accept"] }));
    db.tables.org_members = db.tables.org_members.filter((m) => m.uid !== "o-2");
    // o-1 conflicted and o-2 active would be "independence"; o-2 gone makes it a departure
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r.held).toBe(1);
    expect(auditDetails()).toMatchObject({ holdReason: "no_longer_member" });
  });
});

describe("fix pass 3 — DEC-90 ruling (1) at the close: never on engineered work", () => {
  it("the ticket's column now says engineering is required: HELD ('engineered'), nothing issues", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    db.tables.tickets[0].engineering_required = true;
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ held: 1, issued: 0 });
    expect(db.tables.tickets[0].status).toBe("PENDING_REVIEW");
    expect(auditDetails()).toMatchObject({ holdReason: "engineered", engineered: true });
    expect(lastHistory().action).toMatch(/now engineered work/);
  });
  it("the requester's CURRENT roles no longer exempt them (DEC-16), or they left the workspace: held", async () => {
    for (const change of ["demoted", "removed"] as const) {
      seedTicket({ warned: "2026-10-21T09:00:00Z" });
      db.tables.org_members = change === "demoted"
        ? db.tables.org_members.map((m) => (m.uid === "req" ? member("req", "Viewer") : m))
        : db.tables.org_members.filter((m) => m.uid !== "req");
      db.tables.tickets[0].requester_role = "Viewer";
      db.calls = [];
      const r = await runConsentWindowScan({ client, now: NOW });
      expect(r.held, change).toBe(1);
      expect(auditDetails()).toMatchObject({ holdReason: "engineered" });
    }
  });
  it("the request type became engineering-first: held; the types unreadable: not closed this run (retried), said", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    db.tables.org_configurations = [{ org_id: "o1", key: "drafting", data: { requestTypes: { options: [{ value: "ISO", label: "ISO", engineeringFirst: true }] } } }];
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r.held).toBe(1);
    expect(auditDetails()).toMatchObject({ holdReason: "engineered" });
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    db.tables.org_configurations = [];
    db.calls = [];
    // only the drafting row (the request types) is unreadable; the policy reads
    const draftingFails = {
      ...client,
      from: (t: string) => {
        const b = builder(t) as Record<string, (...a: unknown[]) => unknown>;
        if (t !== "org_configurations") return b;
        const eq = b.eq; const ms = b.maybeSingle;
        let drafting = false;
        b.eq = (k: unknown, v: unknown) => { if (k === "key" && v === "drafting") drafting = true; return eq(k, v); };
        b.maybeSingle = async () => (drafting ? { data: null, error: { code: "57014", message: "timeout" } } : ms());
        return b;
      },
    };
    const r2 = await runConsentWindowScan({ client: draftingFails, now: NOW });
    expect(r2).toMatchObject({ held: 0, advanced: 0, failed: 1 });
    expect(r2.errors.join(" ")).toMatch(/request types could not be read/);
    expect(calls("tickets", "update")).toEqual([]);
    expect(calls("audit_logs", "insert")).toEqual([]);
  });
});

describe("fix pass 3 — FRIC-5: silence issues as-is only on a mark the notice named", () => {
  const mark = { rev: "1A", at: "2026-10-19T08:00:00.000Z" };
  const withMark = () => {
    const t = db.tables.tickets[0];
    t.metadata = { ...(t.metadata as Row), issue_ready: mark };
    t.attachments = [{ id: "a-d", name: "x.pdf", url: "orgs/o1/x.pdf", type: "Draft", rev: "1A", status: "submitted" }];
    return t;
  };
  it("marked AFTER the people were asked (the opening line names no mark): the PENDING_IFC hop, the mark withdrawn, said in the history and the audit row", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    const t = withMark();
    t.history = [{ action: "Consent window opened — Operations", user: "system:consent-window", date: "2026-10-19T09:00:00Z", details: "…" }];
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ issued: 1 });
    expect(t.status).toBe("PENDING_IFC");
    expect("issue_ready" in (t.metadata as Row)).toBe(false);
    expect(lastHistory().details).toMatch(/notice did not name it, so silence does not issue the draft as the final package/);
    expect(auditDetails()).toMatchObject({ issueAsIs: { marked: true, namedAtOpen: false } });
  });
  it("a retry that opens the window while the draft is marked names the mark in the notice, the history line and its key", async () => {
    seedTicket({ window: false });
    withMark();
    await runConsentWindowScan({ client, now: NOW });
    const call = calls("rpc:open_consent_window", "rpc")[0].args[0] as Row;
    expect(String(call.p_body)).toContain(CONSENT_ISSUE_AS_IS_NOTE);
    expect(String(call.p_body)).toContain(ISSUE_AS_IS_NOTE);
    expect(call.p_history).toMatchObject({ consentIssueAsIs: mark });
    expect(String((call.p_history as Row).details)).toContain(CONSENT_ISSUE_AS_IS_NOTE);
    // unmarked: no note, no key
    seedTicket({ window: false });
    db.calls = [];
    await runConsentWindowScan({ client, now: NOW });
    const plain = calls("rpc:open_consent_window", "rpc")[0].args[0] as Row;
    expect(String(plain.p_body)).not.toContain(ISSUE_AS_IS_NOTE);
    expect("consentIssueAsIs" in (plain.p_history as Row)).toBe(false);
  });
  it("the reminder repeats the note when the opening notice named the mark", async () => {
    seedTicket({ warned: null });
    const t = withMark();
    t.history = [{ action: "Consent window opened — Operations", user: "system:consent-window", date: "2026-10-19T09:00:00Z", details: "…", consentIssueAsIs: mark }];
    await runConsentWindowScan({ client, now: Date.parse("2026-10-21T10:00:00Z") });
    const w = calls("rpc:record_consent_window_warning", "rpc")[0].args[0] as Row;
    expect(String(w.p_body)).toContain(CONSENT_ISSUE_AS_IS_NOTE);
    seedTicket({ warned: null });
    db.calls = [];
    await runConsentWindowScan({ client, now: Date.parse("2026-10-21T10:00:00Z") });
    expect(String((calls("rpc:record_consent_window_warning", "rpc")[0].args[0] as Row).p_body)).not.toContain(ISSUE_AS_IS_NOTE);
  });
});

// ─── DF-P7 final fix pass — the integrator's rulings (DEC-90) ───────────────
describe("DF-P7 final fix pass — ruling (1): history never claims a notification that did not happen", () => {
  it("no consent reason, and no roster history note built from one, says anyone was told", () => {
    for (const [k, v] of Object.entries(CONSENT_REASON)) expect(v, k).not.toMatch(/told/);
    for (const reason of [CONSENT_REASON.nobody, CONSENT_REASON.onlyParties, CONSENT_REASON.noLongerAskable]) {
      expect(consentPlanNote({ kind: "blocked", slot: "ops", label: "Operations", reason })).not.toMatch(/told/);
    }
  });
  it("the actor is the only assigner: nobody is belled, the answer and the plan's history note never say anyone was told, and the notice event names nobody", async () => {
    db.tables.org_members = [member("a-1", "Admin"), member("d-1", "Drafter"), member("o-1", "Viewer"), member("req", "Viewer")];
    const roster: TicketReviewRoster = {
      v: 1, id: ROSTER_ID, openedAt: "2026-10-19T09:00:00Z", openedBy: "a-1", level: "library", cycle: "1A", contentHash: "h", files: [],
      slots: [slot({ kind: "ops", label: "Operations", mode: "consent_window", primaries: [], fallback: true })],
      consentPlan: { kind: "blocked", slot: "ops", label: "Operations", reason: CONSENT_REASON.nobody },
    };
    expect(assignmentQueueOf({ members: db.tables.org_members, policy: null, resource: null, requesterId: "req" })).toEqual(["a-1"]);
    const msg = await afterRosterOpened(client, {
      ticketId: "t1", orgId: "o1", ticketLabel: "REQ-1 Gasket", roster, members: db.tables.org_members, policy: null, resource: null,
      requesterId: "req", actor: { uid: "a-1", name: "A-1" },
    });
    expect(msg).toMatch(/named nobody who could be asked/);
    expect(msg).not.toMatch(/told/);
    expect(calls("notifications", "insert")).toEqual([]);
    expect(consentPlanNote(roster.consentPlan)).not.toMatch(/told/);
    const ev = db.tables.ticket_notice_events.filter((e) => e.kind === "blocked");
    expect(ev).toEqual([expect.objectContaining({ details: expect.objectContaining({ escalatedTo: [] }) })]);
  });
  it("the route's block: the queue's bell is refused — the answer does not say told; the event records nobody told and who was not", async () => {
    const roster: TicketReviewRoster = {
      v: 1, id: ROSTER_ID, openedAt: "2026-10-19T09:00:00Z", openedBy: "d-1", level: "library", cycle: "1A", contentHash: "h", files: [],
      slots: [slot({ kind: "ops", label: "Operations", mode: "consent_window", primaries: [], fallback: true })],
      consentPlan: { kind: "blocked", slot: "ops", label: "Operations", reason: CONSENT_REASON.nobody },
    };
    db.errors["notifications:insert"] = { code: "57014", message: "timeout" };
    const msg = await afterRosterOpened(client, {
      ticketId: "t1", orgId: "o1", ticketLabel: "REQ-1", roster, members: db.tables.org_members, policy: null, resource: null,
      requesterId: "req", actor: { uid: "d-1", name: "D-1" },
    });
    expect(msg).not.toMatch(/told/);
    const ev = db.tables.ticket_notice_events.filter((e) => e.kind === "blocked")[0];
    expect(ev.details).toMatchObject({ escalatedTo: [], notTold: ["a-1", "req"], escalationError: "timeout" });
    // …and when the bell lands, the answer says so and the event names who heard
    delete db.errors["notifications:insert"];
    db.tables.ticket_notice_events = [];
    const ok = await afterRosterOpened(client, {
      ticketId: "t1", orgId: "o1", ticketLabel: "REQ-1", roster, members: db.tables.org_members, policy: null, resource: null,
      requesterId: "req", actor: { uid: "d-1", name: "D-1" },
    });
    expect(ok).toMatch(/the assignment queue was told/);
    expect(db.tables.ticket_notice_events.filter((e) => e.kind === "blocked")[0].details).toMatchObject({ escalatedTo: ["a-1", "req"] });
  });
  it("the cron's block of a planned window: a refused bell — the plan's reason, the run's line and the event never say told", async () => {
    seedTicket({ window: false });
    db.tables.org_members = db.tables.org_members.filter((m) => m.uid !== "o-1" && m.uid !== "o-2");
    db.errors["notifications:insert"] = { code: "57014", message: "timeout" };
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(rosterOf().consentPlan).toMatchObject({ kind: "blocked", reason: CONSENT_REASON.noLongerAskable });
    expect(r.errors.filter((l) => /nobody "Operations" names/.test(l)).join(" ")).not.toMatch(/told/);
    expect(db.tables.ticket_notice_events.filter((e) => e.kind === "blocked")[0].details).toMatchObject({ escalatedTo: [], notTold: ["a-1", "req"] });
    // a permanent refusal's reason never claims it either
    seedTicket({ window: false });
    delete db.errors["notifications:insert"];
    db.rpc.open_consent_window = { data: null, error: { code: "22023", message: "refused" } };
    await runConsentWindowScan({ client, now: NOW });
    expect((rosterOf().consentPlan as { reason: string }).reason).not.toMatch(/told/);
  });
  it("the close held 'no_longer_member': the history never says told; the event names only those whose bell landed", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    db.tables.org_members = db.tables.org_members.filter((m) => m.uid !== "o-1" && m.uid !== "o-2");
    db.errors["notifications:insert"] = { code: "57014", message: "timeout" };
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r.held).toBe(1);
    // ("Told, not opened" names the people the window asked — never the queue)
    expect(lastHistory().details).not.toMatch(/assignment queue|queue was told/);
    expect(lastHistory().action).not.toMatch(/assignment queue|queue was told/);
    const blk = db.tables.ticket_notice_events.filter((e) => e.kind === "blocked");
    expect(blk).toEqual([expect.objectContaining({ details: expect.objectContaining({ reason: "no_longer_member", escalatedTo: [], notTold: expect.arrayContaining(["a-1"]) }) })]);
  });
});

describe("DF-P7 final fix pass — ruling (2): a member's email-preference reason never reaches ticket history", () => {
  const PREFS: Array<[Row, string]> = [
    [{ user_id: "o-2", email_enabled: false }, "they turned email off"],
    [{ user_id: "o-2", digest_frequency: "never" }, "they set email delivery to never"],
    [{ user_id: "o-2", email_on_assignment: false }, "they turned assignment emails off"],
  ];
  it("consentChannelNote: a preference names the channel only; a cause that is not a preference keeps its reason", () => {
    const nameOf = (u: string) => u.toUpperCase();
    const note = consentChannelNote({ emails: [{ uid: "o-1", email: "o-1@x.io" }], notEmailed: [
      { uid: "o-2", reason: "they turned email off", byTheirChoice: true },
      { uid: "o-3", reason: "no email address is on record for them", byTheirChoice: false },
    ] }, nameOf);
    expect(note).toBe(" Each was told in the app; by email as well: O-1; in the app only: O-2, O-3 (no email address is on record for them).");
  });
  it("the retry's open and the reminder: no preference reason in p_history; the reason is in the person's own not_emailed row", async () => {
    for (const [pref, reason] of PREFS) {
      seedTicket({ window: false });
      db.tables.ticket_notice_events = [];
      db.tables.notification_preferences = [pref];
      db.calls = [];
      await runConsentWindowScan({ client, now: NOW });
      const open = calls("rpc:open_consent_window", "rpc")[0].args[0] as { p_history: Row; p_body: string };
      expect(JSON.stringify(open.p_history), reason).not.toContain(reason);
      expect(String(open.p_history.details)).toMatch(/in the app only: O-2\./);
      expect(open.p_body).not.toContain(reason);
      expect(db.tables.ticket_notice_events.filter((e) => e.kind === "not_emailed")).toEqual([
        expect.objectContaining({ recipient: "o-2", details: expect.objectContaining({ reason, byTheirChoice: true }) }),
      ]);

      seedTicket({ warned: null });
      db.tables.notification_preferences = [pref];
      db.calls = [];
      await runConsentWindowScan({ client, now: Date.parse("2026-10-21T10:00:00Z") });
      const warn = calls("rpc:record_consent_window_warning", "rpc")[0].args[0] as { p_history: Row };
      expect(JSON.stringify(warn.p_history), reason).not.toContain(reason);
    }
  });
});

describe("DF-P7 final fix pass — ruling (3): a consent close is an issuing act — the declaration stands only on its e-signature", () => {
  const SIG = "5a000000-0000-4000-8000-000000000001";
  const declare = () => Object.assign(db.tables.tickets[0], {
    engineering_required: false, review_model_filed: true, like_in_kind_statement: "Like for like: same gasket, same rating",
    like_in_kind_declared_at: "2026-10-18T09:00:00Z", like_in_kind_declared_by: "req", like_in_kind_signature_id: SIG,
  });
  const goodSig = { id: SIG, org_id: "o1", resource_type: "ticket", resource_id: "t1", signer_user_id: "req" };
  it("REGRESSION: the signature stands — the close issues exactly as before", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    declare();
    db.tables.e_signatures = [goodSig];
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ advanced: 1, issued: 1, held: 0, failed: 0 });
    expect(auditDetails()).not.toHaveProperty("declarationUnverified");
  });
  it("the signature is missing (or signed by someone else, or another ticket's): HELD as 'engineered' — never closed on silence", async () => {
    for (const sigs of [[], [{ ...goodSig, signer_user_id: "o-1" }], [{ ...goodSig, resource_id: "t9" }]]) {
      seedTicket({ warned: "2026-10-21T09:00:00Z" });
      declare();
      db.tables.e_signatures = sigs;
      db.calls = [];
      const r = await runConsentWindowScan({ client, now: NOW });
      expect(r, JSON.stringify(sigs)).toMatchObject({ held: 1, advanced: 0, issued: 0 });
      expect(db.tables.tickets[0].status).toBe("PENDING_REVIEW");
      expect(auditDetails()).toMatchObject({ holdReason: "engineered", engineered: true, declarationUnverified: "missing" });
      expect(rosterOf().slots.find((s) => s.kind === "ops")).toMatchObject({ status: "open" });
      expect(ledgerOps()).toMatchObject({ status: "open" });
    }
  });
  it("the signature cannot be read: not closed this run — a recorded failure, nothing written, retried next run", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    declare();
    db.errors.e_signatures = { code: "57014", message: "timeout" };
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ held: 0, advanced: 0, failed: 1 });
    expect(r.errors.join(" ")).toMatch(/declaration's signature could not be read.* not closed \(retried next run\)/);
    expect(calls("tickets", "update")).toEqual([]);
    expect(calls("audit_logs", "insert")).toEqual([]);
    // the next run, with the read back, closes it
    delete db.errors.e_signatures;
    db.tables.e_signatures = [goodSig];
    const again = await runConsentWindowScan({ client, now: NOW + 60_000 });
    expect(again).toMatchObject({ advanced: 1, issued: 1 });
  });
  it("REGRESSION: an undeclared request never reads e_signatures", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    db.errors.e_signatures = { code: "57014", message: "would fail if read" };
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ advanced: 1, issued: 1 });
    expect(db.calls.some((c) => c.table === "e_signatures")).toBe(false);
  });
});

describe("DF-P7 final fix pass — ruling (4): the planned read never re-reads a window already opened", () => {
  // open_consent_window's stamp, as 20261255 writes it (the columns, the mirror, last_modified)
  const stamping = {
    from: client.from,
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      if (fn !== "open_consent_window") return client.rpc(fn, args);
      db.calls.push({ table: `rpc:${fn}`, method: "rpc", args: [args] });
      const t = db.tables.tickets.find((r) => r.id === args!.p_ticket)!;
      const at = new Date(NOW).toISOString();
      Object.assign(t, {
        consent_window_opened_at: at, consent_window_recipients: args!.p_recipients, consent_window_slot: args!.p_slot, consent_window_roster: args!.p_roster,
        consent_window_warn_at: args!.p_warn_at, consent_window_closes_at: args!.p_closes_at, consent_window_warned_at: null, consent_window_expired_at: null,
        consent_window_objected_at: null, consent_window_objected_by: null, last_modified: at,
      });
      const rr = (t.metadata as { review_roster: TicketReviewRoster }).review_roster;
      rr.consentWindow = { slot: String(args!.p_slot), openedAt: at, warnAt: String(args!.p_warn_at), closesAt: String(args!.p_closes_at), recipients: args!.p_recipients as string[] };
      return { data: (args!.p_recipients as string[]).length, error: null };
    },
  };
  it("a window the retry opens has its plan marked 'opened' (CAS, last_modified untouched) — the next run's planned read does not return it; it is read as running", async () => {
    seedTicket({ window: false });
    const r = await runConsentWindowScan({ client: stamping, now: NOW });
    expect(r.opened).toBe(1);
    expect(r.sets.planned).toEqual({ read: 1, more: false });
    expect(rosterOf().consentPlan).toMatchObject({ kind: "opened", slot: "ops", recipients: ["o-1", "o-2"] });
    expect(db.tables.tickets[0].last_modified).toBe(new Date(NOW).toISOString());
    db.calls = [];
    const next = await runConsentWindowScan({ client: stamping, now: NOW + 3_600_000 });
    expect(next.sets).toEqual({ running: { read: 1, more: false }, planned: { read: 0, more: false } });
    expect(next.opened).toBe(0);
    expect(calls("rpc:open_consent_window", "rpc")).toEqual([]);
  });
  it("a window opened before the mark existed (plan still 'open'): marked on its next read, then gone from the planned set; reminded as before", async () => {
    seedTicket({ warned: null });
    rosterOf().consentPlan = { kind: "open", slot: "ops", label: "Operations", recipients: ["o-1", "o-2"], windowDays: 3, warnFraction: 2 / 3 };
    const lm = db.tables.tickets[0].last_modified;
    const r = await runConsentWindowScan({ client, now: Date.parse("2026-10-20T00:00:00Z") });
    expect(r.sets.planned.read).toBe(1);
    expect(rosterOf().consentPlan).toMatchObject({ kind: "opened" });
    expect(db.tables.tickets[0].last_modified).toBe(lm);
    expect(calls("rpc:open_consent_window", "rpc")).toEqual([]);
    db.calls = [];
    const next = await runConsentWindowScan({ client, now: Date.parse("2026-10-21T10:00:00Z") });
    expect(next.sets.planned.read).toBe(0);
    expect(next.warned).toBe(1);
  });
  it("markConsentPlanOpened writes nothing when the window is not this roster's, or the plan is not 'open'", async () => {
    seedTicket({ window: false });
    expect(await markConsentPlanOpened(client, { ticketId: "t1", rosterId: ROSTER_ID })).toBeNull();
    expect(calls("tickets", "update")).toEqual([]);
    seedTicket({ warned: null });
    db.calls = [];
    expect(await markConsentPlanOpened(client, { ticketId: "t1", rosterId: ROSTER_ID })).toBeNull();
    expect(calls("tickets", "update")).toEqual([]);
  });
  it("each set's size is in the step's result, so a truncated set is visible", async () => {
    seedTicket({ window: false });
    const t1 = db.tables.tickets[0];
    db.tables.tickets.push({ ...structuredClone(t1), id: "t2" }, { ...structuredClone(t1), id: "t3" });
    const r = await runConsentWindowScan({ client, now: Date.parse("2026-10-20T00:00:00Z"), maxTickets: 2, pivot: "t0" });
    expect(r.sets.planned).toEqual({ read: 2, more: true });
    expect(r.sets.running).toEqual({ read: 0, more: false });
    expect(r.truncated).toBe(true);
  });
});

describe("DEC-90 ruling (1) (merge-time fix pass) — the retry and the close re-read the EFFECTIVE routing slot", () => {
  const routingWith = (ops: Record<string, unknown> | null) => {
    db.tables.libraries = [{ id: LIB_ID, routing_control: ops === null ? null : { slots: [CONFIRMED_ROUTING.slots[0], { kind: "ops", label: "Operations", mode: "consent_window", fill: { users: ["o-1", "o-2"] }, ...ops }] } }];
  };
  const untouched = (before: Row) => {
    expect(calls("audit_logs", "insert")).toEqual([]);
    expect(calls("tickets", "update")).toEqual([]);
    expect(db.tables.tickets[0]).toEqual(before);
    expect(ledgerOps().status).toBe("open");
  };
  const closeCases: Array<[string, Record<string, unknown> | null, RegExp]> = [
    ["the slot is not confirmed (a forged or pre-DF-P7 table)", {}, /has not confirmed it as a consent window/],
    ["the slot is filled by the engineering sign-off", { consent_confirmed: true, fill: { capability: "ticket.final_approve" } }, /fills it with the engineering sign-off/],
    ["the slot is filled by the engineering review capability", { consent_confirmed: true, fill: { capability: "ticket.eng_review" } }, /fills it with the engineering sign-off/],
    ["the slot is no longer a consent slot", { consent_confirmed: true, mode: "blocking" }, /no longer makes it a consent slot/],
    ["no routing table applies any more", null, /no routing table applies/],
  ];
  for (const [name, ops, line] of closeCases) {
    it(`the close: ${name} — not closed, nothing written; a line`, async () => {
      seedTicket({ warned: "2026-10-21T09:00:00Z" });
      routingWith(ops);
      const before = JSON.parse(JSON.stringify(db.tables.tickets[0])) as Row;
      const r = await runConsentWindowScan({ client, now: NOW });
      expect(r).toMatchObject({ advanced: 0, issued: 0, held: 0, failed: 1 });
      expect(r.errors.join(" ")).toMatch(line);
      expect(r.errors.join(" ")).toMatch(/the window was not closed; "Operations" waits for a sign-off/);
      untouched(before);
    });
  }
  it("the close: the routing cannot be read — not closed (retried next run), nothing written", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    db.errors.libraries = { code: "08006", message: "connection lost" };
    const before = JSON.parse(JSON.stringify(db.tables.tickets[0])) as Row;
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ advanced: 0, failed: 1 });
    expect(r.errors.join(" ")).toMatch(/routing table could not be read .* the window was not closed \(retried next run\)/);
    untouched(before);
  });
  it("REGRESSION: the slot confirmed in the effective table — the close advances exactly as before (and the reminder never reads the routing)", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ advanced: 1, issued: 1, failed: 0 });
    seedTicket({ warned: null });
    db.calls = [];
    db.errors.libraries = { code: "08006", message: "connection lost" };
    const w = await runConsentWindowScan({ client, now: Date.parse("2026-10-21T10:00:00Z") });
    expect(w.warned).toBe(1);
    expect(db.calls.some((c) => c.table === "libraries")).toBe(false);
  });
  it("the retry: a planned window whose effective slot is not confirmed (a forged metadata plan) never opens — blocked once, refusal recorded", async () => {
    seedTicket({ window: false });
    routingWith({});
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r.opened).toBe(0);
    expect(calls("rpc:open_consent_window", "rpc")).toEqual([]);
    const rr = (db.tables.tickets[0].metadata as { review_roster: TicketReviewRoster }).review_roster;
    expect(rr.consentPlan).toMatchObject({ kind: "blocked", slot: "ops", reason: expect.stringMatching(/has not confirmed it as a consent window/) });
    expect(db.tables.ticket_notice_events.filter((e) => e.kind === "blocked")).toEqual([expect.objectContaining({ details: expect.objectContaining({ reason: "window_never_opened", refusal: expect.objectContaining({ code: "routing_unconfirmed" }) }) })]);
    db.calls = [];
    const again = await runConsentWindowScan({ client, now: NOW });
    expect(again).toMatchObject({ scanned: 0 });
  });
  it("the retry: an engineering-filled effective slot never opens", async () => {
    seedTicket({ window: false });
    routingWith({ consent_confirmed: true, fill: { capability: "ticket.final_approve" } });
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r.opened).toBe(0);
    expect(calls("rpc:open_consent_window", "rpc")).toEqual([]);
  });
  it("the retry: the routing cannot be read — no call, a line, the plan left to retry", async () => {
    seedTicket({ window: false });
    db.errors.libraries = { code: "08006", message: "connection lost" };
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ opened: 0, failed: 1 });
    expect(calls("rpc:open_consent_window", "rpc")).toEqual([]);
    expect(((db.tables.tickets[0].metadata as { review_roster: TicketReviewRoster }).review_roster.consentPlan as { kind: string }).kind).toBe("open");
  });
});


// ─── drafting-flow Round G, DF-P22 — the DF-P7 residuals ────────────────────
// (b) the cron's retry of a planned open re-reads the declaration's
//     e-signature (and the whole engineered lane) as the route and the close
//     do; (c) the PHYS-18 copy recall runs on a consent-completed issue, by
//     the recorded system actor.
const recallSpy = vi.hoisted(() => ({ nudges: [] as Array<Record<string, unknown>>, reads: 0 }));
vi.mock("@/lib/staleCopies", () => ({
  getTicketCopyRecall: async () => {
    recallSpy.reads += 1;
    return { holders: [{ userId: "o-2", userEmail: "o-2@x.io", lastCopiedAt: "2026-10-01T00:00:00Z", copies: [], outdated: true, hasCurrent: false }], capped: false, unavailable: false, latestIssuedRev: "1" };
  },
  nudgeStaleTicketHolders: async (input: Record<string, unknown>) => { recallSpy.nudges.push(input); return 1; },
}));

describe("DF-P22 (b) — the retry re-reads the declaration's e-signature, as the route and the close do", () => {
  const SIG = "5a000000-0000-4000-8000-0000000000aa";
  const declare = () => Object.assign(db.tables.tickets[0], {
    engineering_required: false, review_model_filed: true, like_in_kind_statement: "Like for like: same gasket, same rating",
    like_in_kind_declared_at: "2026-10-18T09:00:00Z", like_in_kind_declared_by: "req", like_in_kind_signature_id: SIG,
  });
  const goodSig = { id: SIG, org_id: "o1", resource_type: "ticket", resource_id: "t1", signer_user_id: "req" };
  it("REGRESSION: a declaration that stands — the retry opens the window exactly as before", async () => {
    seedTicket({ window: false });
    declare();
    db.tables.e_signatures = [goodSig];
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r.opened).toBe(1);
    expect(calls("rpc:open_consent_window", "rpc")).toHaveLength(1);
  });
  it("a declaration whose signature does not stand: no window — the plan becomes an ordinary sign-off (engineered), nobody escalated, the record says why", async () => {
    for (const sigs of [[], [{ ...goodSig, signer_user_id: "o-1" }], [{ ...goodSig, resource_id: "t9" }]]) {
      seedTicket({ window: false });
      declare();
      db.tables.e_signatures = sigs;
      db.tables.ticket_notice_events = [];
      db.calls = [];
      const notesBefore = (db.tables.notifications ?? []).length;
      const r = await runConsentWindowScan({ client, now: NOW });
      expect(r.opened, JSON.stringify(sigs)).toBe(0);
      expect(calls("rpc:open_consent_window", "rpc")).toEqual([]);
      expect(rosterOf().consentPlan).toMatchObject({ kind: "sign_off", slot: "ops", reason: CONSENT_REASON.engineered });
      // nothing is blocked, so the assignment queue is not belled
      expect((db.tables.notifications ?? []).length).toBe(notesBefore);
      const ev = db.tables.ticket_notice_events.find((e) => e.kind === "blocked")!;
      expect(ev.details).toMatchObject({ reason: "window_never_opened", escalatedTo: [], refusal: { code: "declaration_unverified" } });
      // and it is not read as "still to open" again
      db.calls = [];
      await runConsentWindowScan({ client, now: NOW + 60_000 });
      expect(calls("rpc:open_consent_window", "rpc")).toEqual([]);
    }
  });
  it("the signature cannot be read: not retried this run — a recorded line, nothing written; the next run opens it", async () => {
    seedTicket({ window: false });
    declare();
    db.errors.e_signatures = { code: "57014", message: "timeout" };
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ opened: 0, failed: 1 });
    expect(r.errors.join(" ")).toMatch(/declaration's signature could not be read.*consent window was not retried/);
    expect(calls("tickets", "update")).toEqual([]);
    expect(calls("rpc:open_consent_window", "rpc")).toEqual([]);
    delete db.errors.e_signatures;
    db.tables.e_signatures = [goodSig];
    const again = await runConsentWindowScan({ client, now: NOW + 60_000 });
    expect(again.opened).toBe(1);
  });
  it("REGRESSION: an undeclared request's retry never reads e_signatures", async () => {
    seedTicket({ window: false });
    db.errors.e_signatures = { code: "57014", message: "would fail if read" };
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r.opened).toBe(1);
    expect(db.calls.some((c) => c.table === "e_signatures")).toBe(false);
  });
  it("the request's type became engineering-first: no window, the plan becomes a sign-off", async () => {
    seedTicket({ window: false });
    db.tables.org_configurations = [{ org_id: "o1", key: "drafting", data: { requestTypes: { options: [{ value: "ISO", label: "ISO", engineeringFirst: true }] } } }];
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r.opened).toBe(0);
    expect(calls("rpc:open_consent_window", "rpc")).toEqual([]);
    expect(rosterOf().consentPlan).toMatchObject({ kind: "sign_off", reason: CONSENT_REASON.engineered });
  });
});

describe("DF-P22 (c) — the PHYS-18 copy recall on a consent-completed issue, by the recorded system actor", () => {
  beforeEach(() => { recallSpy.nudges = []; recallSpy.reads = 0; });
  it("an issuing close runs the recall once: no person as actor, the system actor named, source auto", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ advanced: 1, issued: 1 });
    expect(recallSpy.reads).toBe(1);
    expect(recallSpy.nudges).toHaveLength(1);
    expect(recallSpy.nudges[0]).toMatchObject({ orgId: "o1", ticketId: "t1", ticketNumber: "REQ-1", actorUserId: null, systemActor: "system:consent-window", source: "auto", latestIssuedRev: "1" });
  });
  it("a held close, or a close that leaves the review waiting on another sign-off, recalls nothing", async () => {
    seedTicket({ warned: "2026-10-21T09:00:00Z", accept: "open" });
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r.issued).toBe(0);
    expect(recallSpy.reads).toBe(0);
    seedTicket({ warned: "2026-10-21T09:00:00Z", accept: "signed-by-drafter" });
    await runConsentWindowScan({ client, now: NOW });
    expect(recallSpy.reads).toBe(0);
  });
});

// DF-P24 fix pass (GAP-102 acceptance 4): a consent close that would ISSUE
// the request meets the examination-scope gate the workflow route runs on an
// issuing approval — missing enforced data (no waiver) or the data unreadable
// where a requirement binds HOLDS the close for a sign-off; a request filed
// before every requirement issues; no requirement → no read (today's close).
describe("DF-P24 fix pass: the examination-scope gate on an issuing close", () => {
  const SCOPE_SINCE = "2026-10-01T00:00:00.000Z";
  const scopeCfg = (requirements: Array<Record<string, unknown>>) => ({
    examinationScope: { fields: [{ key: "gov", label: "Governing code", options: [{ value: "c1", label: "Code one" }] }], requirements },
  });
  const seedScope = (cfg: Row | null, createdAt = "2026-10-05T00:00:00.000Z") => {
    seedTicket({ warned: "2026-10-21T09:00:00Z" });
    db.tables.tickets[0].created_at = createdAt;
    if (cfg) db.tables.org_configurations = [{ org_id: "o1", key: "drafting", data: cfg }];
  };
  const scopeReads = () => calls("ticket_examination_scopes", "select");
  it("required data missing (filed after the requirement, no waiver): HELD ('examination_scope_missing') — not issued, the history names the field", async () => {
    seedScope(scopeCfg([{ field: "gov", libraryId: LIB_ID, since: SCOPE_SINCE }]));
    db.tables.ticket_examination_scopes = [];
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r).toMatchObject({ advanced: 0, held: 1, issued: 0 });
    expect(db.tables.tickets[0].status).toBe("PENDING_REVIEW");
    expect(lastHistory().action).toMatch(/examination data this workspace requires is not recorded/);
    expect(lastHistory().details).toMatch(/Governing code must be recorded before this request issues/);
    expect(auditDetails()).toMatchObject({ holdReason: "examination_scope_missing", examinationScope: { missing: ["gov"] } });
    expect(rosterOf().consentWindow).toMatchObject({ heldReason: "examination_scope_missing" });
    expect(ledgerOps().status).toBe("open");
  });
  it("the data recorded, or a waiver for this revision: issued as before, the audit row naming what it was checked against", async () => {
    seedScope(scopeCfg([{ field: "gov", libraryId: LIB_ID, since: SCOPE_SINCE }]));
    db.tables.ticket_examination_scopes = [{ ticket_id: "t1", org_id: "o1", field_values: { gov: { value: "c1", by: "d-1", at: SCOPE_SINCE } }, waiver: null }];
    expect(await runConsentWindowScan({ client, now: NOW })).toMatchObject({ advanced: 1, issued: 1 });
    expect(db.tables.tickets[0].status).toBe("PENDING_IFC");
    expect(auditDetails()).toMatchObject({ examinationScope: { required: [{ field: "gov", enforced: true, value: "c1" }] } });
    db.calls = [];
    seedScope(scopeCfg([{ field: "gov", libraryId: LIB_ID, since: SCOPE_SINCE }]));
    db.tables.ticket_examination_scopes = [{ ticket_id: "t1", org_id: "o1", field_values: {}, waiver: { reason: "vendor data", by: "a-1", at: SCOPE_SINCE, fields: ["gov"], rev: "1A" } }];
    expect(await runConsentWindowScan({ client, now: NOW })).toMatchObject({ advanced: 1, issued: 1 });
    expect(auditDetails()).toMatchObject({ examinationScope: { missing: ["gov"], waiver: { reason: "vendor data", rev: "1A" } } });
  });
  it("a request filed BEFORE the requirement (in flight when it was configured) is never newly held — it issues, the row saying what was warned", async () => {
    seedScope(scopeCfg([{ field: "gov", libraryId: LIB_ID, since: SCOPE_SINCE }]), "2026-09-01T00:00:00.000Z");
    db.tables.ticket_examination_scopes = [];
    expect(await runConsentWindowScan({ client, now: NOW })).toMatchObject({ advanced: 1, issued: 1 });
    expect(auditDetails()).toMatchObject({ examinationScope: { warnedNotRefused: ["gov"] } });
  });
  it("the data unreadable where a requirement binds: HELD ('examination_scope_unchecked'); for a request filed before it: issued, the row saying unchecked", async () => {
    seedScope(scopeCfg([{ field: "gov", libraryId: LIB_ID, since: SCOPE_SINCE }]));
    db.errors.ticket_examination_scopes = { code: "08006", message: "connection lost" };
    expect(await runConsentWindowScan({ client, now: NOW })).toMatchObject({ held: 1, issued: 0 });
    expect(auditDetails()).toMatchObject({ holdReason: "examination_scope_unchecked", examinationScope: { unreadable: true } });
    db.calls = [];
    seedScope(scopeCfg([{ field: "gov", libraryId: LIB_ID, since: SCOPE_SINCE }]), "2026-09-01T00:00:00.000Z");
    expect(await runConsentWindowScan({ client, now: NOW })).toMatchObject({ advanced: 1, issued: 1 });
    expect(auditDetails()).toMatchObject({ examinationScope: { unchecked: true, required: ["gov"] } });
  });
  it("before 20261266 (42P01): issued — nothing could be recorded — and the row says so", async () => {
    seedScope(scopeCfg([{ field: "gov", libraryId: LIB_ID, since: SCOPE_SINCE }]));
    db.errors.ticket_examination_scopes = { code: "42P01", message: 'relation "ticket_examination_scopes" does not exist' };
    expect(await runConsentWindowScan({ client, now: NOW })).toMatchObject({ advanced: 1, issued: 1 });
    expect(auditDetails()).toMatchObject({ examinationScope: { notMigrated: true, required: ["gov"] } });
  });
  it("REGRESSION: no requirement applies (none configured, another library's, or a close that does not issue) — no read, no key; today's close", async () => {
    for (const cfg of [null, { requestTypes: { options: [] } }, scopeCfg([{ field: "gov", libraryId: "lib-other", since: SCOPE_SINCE }])]) {
      db.calls = [];
      seedScope(cfg as Row | null);
      expect(await runConsentWindowScan({ client, now: NOW })).toMatchObject({ advanced: 1, issued: 1 });
      expect(scopeReads()).toEqual([]);
      expect(JSON.stringify(auditDetails())).not.toMatch(/examinationScope/);
    }
    db.calls = [];
    seedTicket({ warned: "2026-10-21T09:00:00Z", accept: "open" });
    db.tables.tickets[0].created_at = "2026-10-05T00:00:00.000Z";
    db.tables.org_configurations = [{ org_id: "o1", key: "drafting", data: scopeCfg([{ field: "gov", libraryId: LIB_ID, since: SCOPE_SINCE }]) }];
    expect(await runConsentWindowScan({ client, now: NOW })).toMatchObject({ advanced: 1, issued: 0 });
    expect(scopeReads()).toEqual([]);
  });
});
