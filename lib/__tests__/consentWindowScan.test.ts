// drafting-flow Round G, DF-P7 CONSENT — the maintenance cron's ONE step
// (lib/consentWindowScan.ts runConsentWindowScan): the retry of a window the
// route could not open, the reminder (DEC-39), and the close — the
// auto-advance as a recorded SYSTEM act (audit row first, then the
// compare-and-set), written into the ticket's own history naming everyone
// asked, with the append-only notice events and the roster ledger after it.
// Plus the DEC-38 holds: no delivery record → never consent; the producer
// floor → never silence over the drafter's own sign-off.

import { describe, it, expect, beforeEach } from "vitest";
import { runConsentWindowScan, emailPreferenceReason, emailPreferenceOf, assignmentQueueOf, memberNameOf, CONSENT_EMAIL_EVENT } from "@/lib/consentWindowScan";
import { emailAllowedByPrefs, PREFERENCE_EXEMPT_EVENT_TYPES } from "@/lib/notificationPrefs";
import { CONSENT_WINDOW_COLUMNS, CONSENT_WARN_LEAD_MS } from "@/lib/consentWindow";
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
    consentPlan: { kind: "open", slot: "ops", label: "Operations", recipients: ["o-1", "o-2"], windowDays: 3, warnFraction: 2 / 3 },
    ...(opts.window === false ? {} : { consentWindow: { slot: "ops", openedAt: "2026-10-19T09:00:00Z", warnAt: "2026-10-21T09:00:00Z", closesAt: "2026-10-22T09:00:00Z", recipients: ["o-1", "o-2"], ...(opts.warned ? { warnedAt: opts.warned } : {}) } }),
  };
  const windowCols = opts.window === false ? {} : {
    consent_window_opened_at: "2026-10-19T09:00:00Z", consent_window_recipients: ["o-1", "o-2"], consent_window_slot: "ops", consent_window_roster: ROSTER_ID,
    consent_window_warn_at: "2026-10-21T09:00:00Z", consent_window_closes_at: "2026-10-22T09:00:00Z", consent_window_warned_at: opts.warned ?? null,
  };
  db.tables.tickets = [{
    id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "Gasket", status: "PENDING_REVIEW", request_type: "ISO", requester_id: "req", requester_role: "Manager",
    assigned_drafter_id: "d-1", attachments: [], comments: [], history: [], watchers: [], unread_by: [], revision_count: 0, deliverable_rev: "1A",
    last_modified: "2026-10-21T09:00:00Z", archived_at: null, metadata: { review_roster: roster }, ...COLS, ...windowCols,
  }];
  // The roster ledger (ticket_review_slots — service-written), agreeing with the roster.
  db.tables.ticket_review_slots = [
    { id: "la", ticket_id: "t1", roster_id: ROSTER_ID, slot_kind: "accept", mode: "blocking", status: accept === "open" ? "open" : "satisfied", primaries: acceptSlot.primaries, independent_of: [], fallback: false },
    { id: "ls", ticket_id: "t1", roster_id: ROSTER_ID, slot_kind: "ops", mode: "consent_window", status: "open", primaries: ["o-1", "o-2"], independent_of: [], fallback: false },
  ];
}
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
    db.errors.documents = { code: "08006", message: "connection lost" };
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
  it("refused again: a line, nothing else (the slot waits for a sign-off)", async () => {
    seedTicket({ window: false });
    db.rpc.open_consent_window = { data: null, error: { code: "22023", message: "a person to ask is no longer an active member" } };
    const r = await runConsentWindowScan({ client, now: NOW });
    expect(r.failed).toBe(1);
    expect(calls("tickets", "update")).toEqual([]);
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
    expect(hist).toMatch(/Each was told in the app; by email as well: O-1, (A-1, REQ|REQ, A-1); in the app only: O-2 \(they turned email off\)\./);
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
    t.metadata = { ...(t.metadata as Row), source_document: { id: SRC, document_number: "PID-100", rev: "B" }, issue_ready: { rev: "1A" } };
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
