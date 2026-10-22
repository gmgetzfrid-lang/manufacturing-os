// drafting-flow Round G, DF-P22 — FRIC-1 done-when 2 / GAP-106: the
// escalation tier above the queue owners (lib/ticketSla.ts
// runSlaEscalationScan, step 5b of the maintenance cron). DEC-90 ruling (1)
// for DF-P22: a workspace MAY name a contact (a member or a role) and a
// period; a breach its queue owners have not cleared within the period tells
// the contact ONCE per breach per period, through an existing kind
// (ticket_status), recorded on an audit row. Escalation only tells. No
// contact = exactly today's behaviour (pinned across every SLA state).

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseSlaEscalation, escalationPeriodIndex, breachUncleared, escalationRecipients, slaEscalationNotice, runSlaEscalationScan,
  SLA_ACTION, SLA_NOTICE_ACTIONS, SLA_ESCALATION_ACTOR, SLA_ESCALATION_AUDIT_ACTION, SLA_ESCALATION_DEFAULT_DAYS,
  type SlaEmitInput,
} from "@/lib/ticketSla";

type Row = Record<string, unknown>;
const db = {
  tables: {} as Record<string, Row[]>,
  calls: [] as Array<{ table: string; method: string }>,
  errors: {} as Record<string, { code?: string; message: string }>,
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
  let op: "select" | "insert" | "delete" | "update" = "select";
  let payload: unknown = null;
  let limit = Infinity;
  db.calls.push({ table, method: "from" });
  const matched = () => (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (k: string, v: unknown) => { filters.push((r) => pathGet(r, k) === v); return b; },
    is: (k: string, v: unknown) => { filters.push((r) => (pathGet(r, k) ?? null) === v); return b; },
    not: (k: string, how: string, v: unknown) => {
      if (how === "is") filters.push((r) => (pathGet(r, k) ?? null) !== v);
      if (how === "in") { const vs = String(v).replace(/[()]/g, "").split(","); filters.push((r) => !vs.includes(String(pathGet(r, k)))); }
      return b;
    },
    in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(pathGet(r, k))); return b; },
    lte: (k: string, v: string) => { filters.push((r) => String(pathGet(r, k)) <= v); return b; },
    order: () => b,
    limit: (n: number) => { limit = n; return b; },
    insert: (rows: unknown) => { op = "insert"; payload = rows; return b; },
    delete: () => { op = "delete"; return b; },
    update: (p: unknown) => { op = "update"; payload = p; return b; },
    maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => void) => {
      const err = db.errors[`${table}:${op}`] ?? (op === "select" ? db.errors[table] : undefined);
      if (err) return resolve({ data: null, error: err });
      if (op === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]) as Row[];
        if (table === "ticket_sla_escalations") {
          for (const r of rows) {
            if ((db.tables[table] ?? []).some((x) => x.ticket_id === r.ticket_id && x.breached_at === r.breached_at && x.period_index === r.period_index)) {
              return resolve({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } });
            }
          }
        }
        db.tables[table] = [...(db.tables[table] ?? []), ...rows];
        return resolve({ data: null, error: null });
      }
      if (op === "delete") {
        const mm = new Set(matched());
        db.tables[table] = (db.tables[table] ?? []).filter((r) => !mm.has(r));
        return resolve({ data: null, error: null });
      }
      if (op === "update") {
        const mm = matched();
        for (const r of mm) Object.assign(r, payload as Row);
        return resolve({ data: mm.map((r) => ({ id: r.id })), error: null });
      }
      return resolve({ data: matched().slice(0, limit), error: null });
    },
  };
  return b;
}
const client = { from: (t: string) => builder(t) } as never;

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-22T03:00:00Z");
const ORG = "o1";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const member = (uid: string, role: string, roles: string[] = [role]) => ({ org_id: ORG, uid, role, roles, display_name: uid.slice(0, 4), email: `${uid.slice(0, 4)}@x.io`, status: "active" });
const breachedTicket = (over: Row = {}): Row => ({
  id: "t1", org_id: ORG, ticket_id: "REQ-1", title: "Gasket", status: "DRAFTING", request_type: "ISO",
  requester_id: "req", assigned_drafter_id: "d-1", assigned_engineer_id: null,
  created_at: "2026-09-01T00:00:00Z", target_completion_at: "2026-10-15T00:00:00Z",
  sla_breach_warned_at: "2026-10-10T03:00:00Z", sla_breached_at: "2026-10-15T03:00:00Z", archived_at: null, ...over,
});
let emitted: SlaEmitInput[] = [];
let reach = 1;
const emit = async (input: SlaEmitInput) => { emitted.push(input); return { recipients: reach, inapp: { sent: reach, failed: 0 } }; };

beforeEach(() => {
  db.tables = {
    org_members: [member(ADMIN, "Admin"), member(LEAD, "Manager", ["Manager", "DraftingSupervisor"]), member("d-1", "Drafter"), member("req", "Requester")],
    org_configurations: [],
    tickets: [breachedTicket()],
    ticket_sla_escalations: [],
    audit_logs: [],
  };
  db.calls = [];
  db.errors = {};
  emitted = [];
  reach = 1;
});
const configure = (esc: unknown) => { db.tables.org_configurations = [{ org_id: ORG, key: "drafting", data: { requestTypes: { options: [] }, slaEscalation: esc } }]; };

describe("the escalation setting — parsed, never guessed", () => {
  it("absent or null → nothing configured (today's behaviour); a contact with no period → the default period", () => {
    expect(parseSlaEscalation(undefined)).toEqual({ ok: true, config: null });
    expect(parseSlaEscalation(null)).toEqual({ ok: true, config: null });
    expect(parseSlaEscalation({})).toEqual({ ok: true, config: null });
    expect(parseSlaEscalation({ contact: { kind: "role", role: "Admin" } })).toEqual({ ok: true, config: { contact: { kind: "role", role: "Admin" }, periodDays: SLA_ESCALATION_DEFAULT_DAYS } });
    expect(parseSlaEscalation({ contact: { kind: "member", uid: ADMIN }, periodDays: 5 })).toEqual({ ok: true, config: { contact: { kind: "member", uid: ADMIN }, periodDays: 5 } });
  });
  it("a value it cannot use is refused with the reason (never trimmed into something else)", () => {
    for (const bad of [[], "x", { contact: "Admin" }, { contact: { kind: "member", uid: "not-a-uuid" } }, { contact: { kind: "role", role: " " } }, { contact: { kind: "team" } },
      { contact: { kind: "role", role: "Admin" }, periodDays: 0 }, { contact: { kind: "role", role: "Admin" }, periodDays: 31 }, { contact: { kind: "role", role: "Admin" }, periodDays: 1.5 }]) {
      expect(parseSlaEscalation(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it("the period index, the uncleared rule and the contact's members (additive roles, active members only)", () => {
    expect(escalationPeriodIndex("2026-10-15T03:00:00Z", NOW, 2)).toBe(3);
    expect(escalationPeriodIndex("2026-10-21T03:00:00Z", NOW, 2)).toBe(0);
    expect(escalationPeriodIndex(null, NOW, 2)).toBe(0);
    expect(breachUncleared({ status: "DRAFTING", slaBreachedAt: "x", targetCompletionAt: "2026-10-15T00:00:00Z" }, NOW)).toBe(true);
    expect(breachUncleared({ status: "CLOSED", slaBreachedAt: "x", targetCompletionAt: "2026-10-15T00:00:00Z" }, NOW)).toBe(false);
    expect(breachUncleared({ status: "DRAFTING", slaBreachedAt: "x", targetCompletionAt: "2026-11-15T00:00:00Z" }, NOW)).toBe(false);
    expect(breachUncleared({ status: "DRAFTING", slaBreachedAt: "x", targetCompletionAt: null, archivedAt: "2026-10-20" }, NOW)).toBe(false);
    const ms = [{ uid: ADMIN, roles: ["Admin"] }, { uid: LEAD, roles: ["Manager", "DraftingSupervisor"] }];
    expect(escalationRecipients({ kind: "role", role: "DraftingSupervisor" }, ms)).toEqual([LEAD]);
    expect(escalationRecipients({ kind: "member", uid: ADMIN }, ms)).toEqual([ADMIN]);
    expect(escalationRecipients({ kind: "member", uid: "gone" }, ms)).toEqual([]);
  });
  it("its notice says it changed nothing; its action is retired only on exit, like the other two", () => {
    const n = slaEscalationNotice({ id: "t1", orgId: ORG, ticketId: "REQ-1", title: "Gasket", status: "DRAFTING" }, { breachedAt: "2026-10-15T03:00:00Z", periodDays: 2, periodIndex: 3 }, "UTC");
    expect(n.title).toBe("Escalated: still overdue · REQ-1 Gasket");
    expect(n.body).toMatch(/6 days after its queue was told/);
    expect(n.body).toMatch(/nothing was reassigned or changed/);
    expect(SLA_NOTICE_ACTIONS.has(SLA_ACTION.escalation)).toBe(true);
    expect([...SLA_NOTICE_ACTIONS]).toEqual(["sla_warning", "sla_breach", "sla_escalation"]);
  });
});

describe("no contact configured = exactly today's behaviour", () => {
  it("reads ONE configuration list and stops — no ticket read, no notice, no write — on every SLA state", async () => {
    for (const state of [{}, { sla_breached_at: null }, { sla_breach_warned_at: null, sla_breached_at: null }, { status: "CLOSED" }, { status: "PENDING_REVIEW" }]) {
      db.tables.tickets = [breachedTicket(state)];
      db.calls = [];
      const r = await runSlaEscalationScan({ client, emit, now: NOW });
      expect(r).toEqual({ ready: false, configured: 0, scanned: 0, escalated: 0, unreached: 0, truncated: false, errors: [] });
      expect(db.calls.map((c) => c.table)).toEqual(["org_configurations"]);
      expect(emitted).toEqual([]);
      expect(db.tables.audit_logs).toEqual([]);
    }
  });
  it("a drafting configuration WITHOUT slaEscalation is not even returned by the read (the row filter), so it is today's step", async () => {
    db.tables.org_configurations = [{ org_id: ORG, key: "drafting", data: { requestTypes: { options: [] } } }];
    const r = await runSlaEscalationScan({ client, emit, now: NOW });
    expect(r.configured).toBe(0);
    expect(emitted).toEqual([]);
  });
  it("an unusable stored setting escalates nothing and says why", async () => {
    configure({ contact: { kind: "role", role: "Admin" }, periodDays: 99 });
    const r = await runSlaEscalationScan({ client, emit, now: NOW });
    expect(r.configured).toBe(0);
    expect(r.errors.join(" ")).toMatch(/whole number of days from 1 to 30/);
    expect(emitted).toEqual([]);
  });
});

describe("a configured contact hears of an uncleared breach once per breach per period", () => {
  it("before 20261264 is pasted: nothing is sent, said", async () => {
    configure({ contact: { kind: "role", role: "Admin" }, periodDays: 2 });
    db.errors.ticket_sla_escalations = { code: "42P01", message: 'relation "public.ticket_sla_escalations" does not exist' };
    const r = await runSlaEscalationScan({ client, emit, now: NOW });
    expect(r.ready).toBe(false);
    expect(r.errors.join(" ")).toMatch(/starts when 20261264 is pasted/);
    expect(emitted).toEqual([]);
  });
  it("claim → notice (ticket_status, category sla, the contact only) → audit row naming the system actor; it never writes the ticket", async () => {
    configure({ contact: { kind: "role", role: "Admin" }, periodDays: 2 });
    const before = JSON.stringify(db.tables.tickets);
    const r = await runSlaEscalationScan({ client, emit, now: NOW });
    expect(r).toMatchObject({ ready: true, configured: 1, escalated: 1, unreached: 0 });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ orgId: ORG, category: "sla", kind: "ticket_status", audience: { involved: [ADMIN] }, link: "/requests/t1",
      metadata: { action: "sla_escalation", periodIndex: 3, periodDays: 2, breachedAt: "2026-10-15T03:00:00Z" } });
    expect(db.tables.ticket_sla_escalations).toHaveLength(1);
    expect(db.tables.ticket_sla_escalations[0]).toMatchObject({ ticket_id: "t1", breached_at: "2026-10-15T03:00:00Z", period_index: 3, period_days: 2, recipients: [ADMIN] });
    expect(db.tables.audit_logs).toHaveLength(1);
    expect(db.tables.audit_logs[0]).toMatchObject({ action: SLA_ESCALATION_AUDIT_ACTION, user_id: null, user_email: SLA_ESCALATION_ACTOR, user_role: "system", resource_id: "t1",
      details: { periodIndex: 3, contact: { kind: "role", role: "Admin" }, recipients: [ADMIN] } });
    expect(JSON.stringify(db.tables.tickets)).toBe(before);
  });
  it("the same period again sends nothing; the next period sends once more", async () => {
    configure({ contact: { kind: "member", uid: LEAD }, periodDays: 2 });
    await runSlaEscalationScan({ client, emit, now: NOW });
    await runSlaEscalationScan({ client, emit, now: NOW + 3600_000 });
    expect(emitted).toHaveLength(1);
    await runSlaEscalationScan({ client, emit, now: NOW + 2 * DAY });
    expect(emitted).toHaveLength(2);
    expect(emitted[1].metadata).toMatchObject({ periodIndex: 4 });
    expect(emitted.every((e) => e.audience.involved.join() === LEAD)).toBe(true);
  });
  it("a breach not yet a whole period old, a request that ended, was archived or whose target moved past now — nothing", async () => {
    configure({ contact: { kind: "role", role: "Admin" }, periodDays: 2 });
    for (const over of [{ sla_breached_at: "2026-10-21T03:00:00Z" }, { status: "CLOSED" }, { status: "CANCELED" }, { archived_at: "2026-10-20T00:00:00Z" }, { target_completion_at: "2026-11-30T00:00:00Z" }, { sla_breached_at: null }]) {
      db.tables.tickets = [breachedTicket(over)];
      await runSlaEscalationScan({ client, emit, now: NOW });
    }
    expect(emitted).toEqual([]);
    expect(db.tables.audit_logs).toEqual([]);
  });
  it("a notice that reached nobody releases its claim (retried next run), and writes no audit row claiming it went out", async () => {
    configure({ contact: { kind: "role", role: "Admin" }, periodDays: 2 });
    reach = 0;
    const r = await runSlaEscalationScan({ client, emit, now: NOW });
    expect(r.unreached).toBe(1);
    expect(db.tables.ticket_sla_escalations).toEqual([]);
    expect(db.tables.audit_logs).toEqual([]);
    reach = 1;
    await runSlaEscalationScan({ client, emit, now: NOW });
    expect(db.tables.ticket_sla_escalations).toHaveLength(1);
  });
  it("a contact that names nobody (no active holder of the role) sends nothing and says so", async () => {
    configure({ contact: { kind: "role", role: "QAQC" }, periodDays: 2 });
    const r = await runSlaEscalationScan({ client, emit, now: NOW });
    expect(r.errors.join(" ")).toMatch(/names nobody/);
    expect(emitted).toEqual([]);
  });
  it("a claim another run already holds (23505) is skipped quietly — never sent twice", async () => {
    configure({ contact: { kind: "role", role: "Admin" }, periodDays: 2 });
    db.tables.ticket_sla_escalations = [];
    const first = runSlaEscalationScan({ client, emit, now: NOW });
    const second = runSlaEscalationScan({ client, emit, now: NOW });
    await Promise.all([first, second]);
    expect(emitted).toHaveLength(1);
  });
});

describe("the cron and the record (source pins)", () => {
  const route = readFileSync(join(process.cwd(), "app/api/cron/maintenance/route.ts"), "utf8");
  it("the pass runs inside step 5b, after runTicketSlaScan, under its deadline, through emit() as the service role; no new cron entry", () => {
    const i = route.indexOf("const sla = await runTicketSlaScan({");
    const j = route.indexOf("const esc = await runSlaEscalationScan({");
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
    expect(route.slice(j, j + 400)).toContain("emit: (input) => runWithServerClient(sb, () => emit(input)),");
    expect(route.slice(j, j + 400)).toContain("deadlineAt: slaDeadlineAt,");
    expect(route).toContain("if (esc.configured > 0 || escErrors.length > 0) result.ticketSlaEscalation = escCounts;");
    expect(route.match(/runSlaEscalationScan\(/g)).toHaveLength(1);
    const v = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as { crons: unknown[] };
    expect(v.crons).toHaveLength(2);
  });
  it("runTicketSlaScan itself is untouched by the tier (its own pins in ticketSla.test.ts still hold) — the tier never writes tickets", () => {
    const sla = readFileSync(join(process.cwd(), "lib/ticketSla.ts"), "utf8");
    const tier = sla.slice(sla.indexOf("export async function runSlaEscalationScan"));
    expect(tier).not.toMatch(/from\("tickets"\)\s*\.update/);
    expect(tier).not.toMatch(/\.from\("tickets"\)\.update/);
  });
});
