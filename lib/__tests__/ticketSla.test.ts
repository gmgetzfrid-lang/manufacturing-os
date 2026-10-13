// drafting-flow Round G, DF-P3 ROUTING — GAP-106 / EDGE-7 / ROUTE-9: the
// drafting-request SLA clock (lib/ticketSla.ts) and its one step in the
// maintenance cron.
//
// The pure evaluation (75 % warn, breach at the target, once each), who hears
// (the party the CURRENT status waits on, its routed pool, the queue and the
// requester on a breach), and the scan driven against an in-memory store: the
// claim-before-send compare-and-set, idempotence across runs, a send that
// reaches nobody releasing its claim, a transition racing the scan, an org
// whose members cannot be read, and sla_defaults as the only source of a
// window for a ticket with no target.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SLA_WARN_FRACTION, effectiveTarget, warnAt, slaStage, waitingParty, slaRecipients, slaNotice,
  runTicketSlaScan, type SlaTicket, type SlaEmitInput,
} from "@/lib/ticketSla";
import type { RoutingClient } from "@/lib/ticketRouting";

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const tk = (over: Partial<SlaTicket> = {}): SlaTicket => ({
  id: "t1", orgId: "o1", ticketId: "REQ-1", title: "Pump iso", status: "DRAFTING", requestType: "ISO",
  requesterId: "req-1", assignedDrafterId: "d-1", assignedEngineerId: null,
  createdAt: iso(T0), targetCompletionAt: iso(T0 + 4 * DAY), slaBreachWarnedAt: null, slaBreachedAt: null,
  ...over,
});

describe("GAP-106 — the evaluation (pure)", () => {
  it("the warn fraction is a named constant at 75 %", () => {
    expect(SLA_WARN_FRACTION).toBe(0.75);
    expect(warnAt(tk(), T0 + 4 * DAY)).toBe(T0 + 3 * DAY);
  });
  it("none before 75 %, warn from 75 %, breach at the target; each once", () => {
    const t = tk();
    const target = effectiveTarget(t)!;
    expect(slaStage(t, T0 + 2.9 * DAY, target)).toBe("none");
    expect(slaStage(t, T0 + 3 * DAY, target)).toBe("warn");
    expect(slaStage({ ...t, slaBreachWarnedAt: iso(T0 + 3 * DAY) }, T0 + 3.5 * DAY, target)).toBe("none");
    expect(slaStage({ ...t, slaBreachWarnedAt: iso(T0 + 3 * DAY) }, T0 + 4 * DAY, target)).toBe("breach");
    // a breach found before any warning goes straight to the breach
    expect(slaStage(t, T0 + 5 * DAY, target)).toBe("breach");
    expect(slaStage({ ...t, slaBreachedAt: iso(T0 + 4 * DAY) }, T0 + 9 * DAY, target)).toBe("none");
  });
  it("a request that ended is never on the clock; neither is one with no window", () => {
    for (const status of ["CLOSED", "CANCELED"]) expect(slaStage(tk({ status }), T0 + 9 * DAY, T0 + 4 * DAY)).toBe("none");
    expect(slaStage(tk(), T0 + 9 * DAY, null)).toBe("none");
  });
  it("sla_defaults is the ONLY source of a window for a ticket with no target (DEFAULT_SLA_DAYS is never applied retroactively)", () => {
    const noTarget = tk({ targetCompletionAt: null });
    expect(effectiveTarget(noTarget)).toBeNull();
    expect(effectiveTarget(noTarget, new Map([["MOC", 7]]))).toBeNull();
    expect(effectiveTarget(noTarget, new Map([["ISO", 10]]))).toBe(T0 + 10 * DAY);
    // the ticket's own target wins over the org default
    expect(effectiveTarget(tk(), new Map([["ISO", 10]]))).toBe(T0 + 4 * DAY);
  });
});

describe("ROUTE-9 done-when 2 — who hears: the party the CURRENT status waits on, never only requester + drafter", () => {
  const pools = { routed: [] as string[], queue: ["sup-1"] };
  it("the waiting party per status", () => {
    expect(waitingParty(tk({ status: "DRAFTING" }))).toEqual(["d-1"]);
    expect(waitingParty(tk({ status: "PENDING_IFC" }))).toEqual(["d-1"]);
    expect(waitingParty(tk({ status: "PENDING_REVIEW" }))).toEqual(["req-1"]);
    expect(waitingParty(tk({ status: "FINAL_DRAFT" }))).toEqual(["req-1"]);
    expect(waitingParty(tk({ status: "PENDING_ENG_TEAM", assignedEngineerId: "e-1" }))).toEqual(["e-1"]);
    expect(waitingParty(tk({ status: "PENDING_FINAL_APPROVAL", assignedEngineerId: "e-1" }))).toEqual(["e-1"]);
    expect(waitingParty(tk({ status: "PENDING_ASSIGNMENT", assignedDrafterId: null }))).toEqual([]);
  });
  it("an overdue PENDING_ASSIGNMENT ticket (no drafter to nag) warns the queue it sits in", () => {
    const t = tk({ status: "PENDING_ASSIGNMENT", assignedDrafterId: null });
    expect(slaRecipients(t, "warn", { routed: ["sup-1"], queue: ["sup-1"] })).toEqual(["sup-1"]);
    expect(slaRecipients(t, "breach", { routed: ["sup-1"], queue: ["sup-1"] }).sort()).toEqual(["req-1", "sup-1"]);
  });
  it("a drafting ticket warns its drafter; its breach escalates above them (the queue) and to the requester", () => {
    expect(slaRecipients(tk(), "warn", pools)).toEqual(["d-1"]);
    expect(slaRecipients(tk(), "breach", pools).sort()).toEqual(["d-1", "req-1", "sup-1"]);
  });
  it("a status that names nobody falls back to the queue", () => {
    expect(slaRecipients(tk({ status: "PENDING_ENG_TEAM", assignedEngineerId: null }), "warn", pools)).toEqual(["sup-1"]);
  });
  it("the notice names the date in the org's zone and says it was due", () => {
    const n = slaNotice(tk(), "breach", T0 + 4 * DAY, "UTC");
    expect(n.title).toBe("Overdue · REQ-1 Pump iso");
    expect(n.body).toMatch(/was due .*and is still waiting at DRAFTING/);
    expect(slaNotice(tk(), "warn", T0 + 4 * DAY, "UTC").title).toBe("Due soon · REQ-1 Pump iso");
  });
});

// ── the scan against an in-memory store ─────────────────────────────────────
type RowT = Record<string, unknown>;
/** A PostgREST logic tree (`a.gt."x",and(b.eq.y,c.is.null)`) as a predicate —
 *  the subset the scan writes. */
function logic(tree: string, mode: "or" | "and"): (r: RowT) => boolean {
  const terms: string[] = [];
  let depth = 0, quoted = false, cur = "";
  for (const ch of tree) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === "(") depth += 1;
    if (!quoted && ch === ")") depth -= 1;
    if (!quoted && depth === 0 && ch === ",") { terms.push(cur); cur = ""; continue; }
    cur += ch;
  }
  terms.push(cur);
  const preds = terms.map((t): ((r: RowT) => boolean) => {
    const nested = /^(and|or)\((.*)\)$/.exec(t);
    if (nested) return logic(nested[2], nested[1] as "or" | "and");
    const [, col, op, raw] = /^([a-z_]+)\.(gt|eq|lte|is)\.(.*)$/.exec(t)!;
    const v = raw.replace(/^"|"$/g, "");
    if (op === "is") return (r) => (r[col] ?? null) === (v === "null" ? null : v);
    if (op === "eq") return (r) => String(r[col]) === v;
    if (op === "gt") return (r) => r[col] != null && String(r[col]) > v;
    return (r) => r[col] != null && String(r[col]) <= v;
  });
  return mode === "or" ? (r) => preds.some((p) => p(r)) : (r) => preds.every((p) => p(r));
}
function store(seed: Record<string, RowT[]>, opts: { failRead?: string } = {}) {
  const db: Record<string, RowT[]> = JSON.parse(JSON.stringify(seed));
  const writes: Array<{ table: string; patch: RowT; ids: string[] }> = [];
  const reads: string[] = [];
  const from = (table: string) => {
    const filters: Array<(r: RowT) => boolean> = [];
    let patch: RowT | null = null;
    let limit = Infinity;
    const order: string[] = [];
    let wantRows = false;
    let head = false;
    const run = () => {
      if (opts.failRead === table && !patch) return { data: null, error: { message: `${table} unreadable` } };
      reads.push(table);
      let rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (head) return { data: null, count: rows.length, error: null };
      if (order.length) rows = [...rows].sort((a, b) => { for (const k of order) { const c = String(a[k]).localeCompare(String(b[k])); if (c) return c; } return 0; });
      rows = rows.slice(0, limit);
      if (patch) {
        for (const r of rows) Object.assign(r, patch);
        writes.push({ table, patch, ids: rows.map((r) => String(r.id)) });
        return { data: wantRows ? rows.map((r) => ({ id: r.id })) : null, error: null };
      }
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    const q: Record<string, unknown> = {
      select: (_c?: string, o?: { head?: boolean }) => { wantRows = true; if (o?.head) head = true; return q; },
      update: (p: RowT) => { patch = p; return q; },
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
      is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return q; },
      gt: (k: string, v: unknown) => { filters.push((r) => String(r[k]) > String(v)); return q; },
      lte: (k: string, v: unknown) => { filters.push((r) => r[k] !== null && r[k] !== undefined && String(r[k]) <= String(v)); return q; },
      or: (tree: string) => { filters.push(logic(tree, "or")); return q; },
      not: (k: string, op: string, v: string | null) => {
        if (op === "in") { const set = String(v).replace(/[()]/g, "").split(","); filters.push((r) => !set.includes(String(r[k]))); }
        if (op === "is" && v === null) filters.push((r) => (r[k] ?? null) !== null);
        return q;
      },
      order: (k: string) => { order.push(k); return q; },
      limit: (n: number) => { limit = n; return q; },
      maybeSingle: async () => { const r = run(); return { data: (r.data as RowT[] | null)?.[0] ?? null, error: r.error }; },
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, ko),
    };
    return q;
  };
  return { client: { from } as unknown as RoutingClient, db, writes, reads };
}

const members = [
  { org_id: "o1", uid: "req-1", role: "Requester", roles: ["Requester"], status: "active" },
  { org_id: "o1", uid: "d-1", role: "Drafter", roles: ["Drafter"], status: "active" },
  { org_id: "o1", uid: "sup-1", role: "DraftingSupervisor", roles: ["DraftingSupervisor"], status: "active" },
  { org_id: "o1", uid: "a-1", role: "Admin", roles: ["Admin"], status: "active" },
];
const row = (over: RowT = {}): RowT => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "Pump iso", status: "DRAFTING", request_type: "ISO",
  requester_id: "req-1", assigned_drafter_id: "d-1", assigned_engineer_id: null, archived_at: null,
  created_at: iso(T0), target_completion_at: iso(T0 + 4 * DAY), sla_breach_warned_at: null, sla_breached_at: null, ...over,
});

/** emit() as lib/notify/dispatch.ts answers it: `resolve` is how many
 *  recipients it resolved (both channels go to them), `reach` how many bell
 *  rows landed. */
function emitter(reach: (i: SlaEmitInput) => number = (i) => i.audience.involved.length, resolve: (i: SlaEmitInput) => number = (i) => i.audience.involved.length) {
  const sent: SlaEmitInput[] = [];
  return {
    sent,
    emit: async (i: SlaEmitInput) => {
      sent.push(i);
      const r = resolve(i);
      if (r === 0) return { recipients: 0 };
      const n = Math.min(reach(i), r);
      return { recipients: r, inapp: { sent: n, failed: r - n } };
    },
  };
}

describe("GAP-106 / ROUTE-9 done-when 1 + 3 — the scan: one notice per stage per recipient, idempotent across runs", () => {
  it("warns at 75 %, stamps sla_breach_warned_at, and a second run the same day sends nothing", async () => {
    const s = store({ tickets: [row()], org_members: members, org_configurations: [], sla_defaults: [] });
    const e = emitter();
    const r1 = await runTicketSlaScan({ client: s.client, emit: e.emit, now: T0 + 3.2 * DAY });
    expect(r1).toMatchObject({ warned: 1, breached: 0, unreached: 0, errors: [] });
    expect(e.sent).toHaveLength(1);
    expect(e.sent[0]).toMatchObject({
      orgId: "o1", category: "sla", kind: "ticket_status", link: "/requests/t1", resource: { type: "ticket", id: "t1" },
      audience: { involved: ["d-1"] }, metadata: { action: "sla_warning", status: "DRAFTING", sla: "warn" },
    });
    expect(s.db.tickets[0].sla_breach_warned_at).toBe(iso(T0 + 3.2 * DAY));
    expect(s.db.tickets[0].sla_breached_at).toBeNull();
    const r2 = await runTicketSlaScan({ client: s.client, emit: e.emit, now: T0 + 3.4 * DAY });
    expect(r2.warned + r2.breached).toBe(0);
    expect(e.sent).toHaveLength(1);
  });
  it("past the target: the breach goes to the drafter, the queue and the requester, once; later runs read nothing", async () => {
    const s = store({ tickets: [row({ sla_breach_warned_at: iso(T0 + 3 * DAY) })], org_members: members, org_configurations: [], sla_defaults: [] });
    const e = emitter();
    const r1 = await runTicketSlaScan({ client: s.client, emit: e.emit, now: T0 + 5 * DAY });
    expect(r1.breached).toBe(1);
    expect([...e.sent[0].audience.involved].sort()).toEqual(["d-1", "req-1", "sup-1"]);
    expect(e.sent[0].metadata).toMatchObject({ action: "sla_breach", sla: "breach" });
    expect(s.db.tickets[0].sla_breached_at).toBe(iso(T0 + 5 * DAY));
    // the warning stamp is kept as it was
    expect(s.db.tickets[0].sla_breach_warned_at).toBe(iso(T0 + 3 * DAY));
    await runTicketSlaScan({ client: s.client, emit: e.emit, now: T0 + 6 * DAY });
    expect(e.sent).toHaveLength(1);
  });
  it("a breach found with no warning sent stamps both, so the warning never follows it", async () => {
    const s = store({ tickets: [row()], org_members: members, org_configurations: [], sla_defaults: [] });
    await runTicketSlaScan({ client: s.client, emit: emitter().emit, now: T0 + 9 * DAY });
    expect(s.db.tickets[0].sla_breached_at).toBe(iso(T0 + 9 * DAY));
    expect(s.db.tickets[0].sla_breach_warned_at).toBe(iso(T0 + 9 * DAY));
  });
  it("an overdue PENDING_ASSIGNMENT ticket escalates to the queue (the DraftingSupervisor; Admins step aside) and the requester", async () => {
    const s = store({ tickets: [row({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null })], org_members: members, org_configurations: [], sla_defaults: [] });
    const e = emitter();
    await runTicketSlaScan({ client: s.client, emit: e.emit, now: T0 + 5 * DAY });
    expect([...e.sent[0].audience.involved].sort()).toEqual(["req-1", "sup-1"]);
  });
  it("only active members hear (a suspended drafter is not addressed)", async () => {
    const s = store({ tickets: [row()], org_members: [...members.filter((m) => m.uid !== "d-1"), { ...members[1], status: "suspended" }], org_configurations: [], sla_defaults: [] });
    const e = emitter();
    await runTicketSlaScan({ client: s.client, emit: e.emit, now: T0 + 5 * DAY });
    expect(e.sent[0].audience.involved).not.toContain("d-1");
  });
  it("a notice that reached nobody releases its claim and says so; the next run sends it", async () => {
    const s = store({ tickets: [row()], org_members: members, org_configurations: [], sla_defaults: [] });
    const r1 = await runTicketSlaScan({ client: s.client, emit: emitter(() => 0, () => 0).emit, now: T0 + 3.2 * DAY });
    expect(r1).toMatchObject({ warned: 0, unreached: 1 });
    expect(r1.errors.join(" ")).toMatch(/reached nobody/);
    expect(s.db.tickets[0].sla_breach_warned_at).toBeNull();
    const e = emitter();
    const r2 = await runTicketSlaScan({ client: s.client, emit: e.emit, now: T0 + 3.3 * DAY });
    expect(r2.warned).toBe(1);
  });
  it("bell rows that landed for nobody while the email was queued KEEP the claim (no daily re-mail) and say so", async () => {
    const s = store({ tickets: [row()], org_members: members, org_configurations: [], sla_defaults: [] });
    const e = emitter(() => 0);
    const r1 = await runTicketSlaScan({ client: s.client, emit: e.emit, now: T0 + 5 * DAY });
    expect(r1).toMatchObject({ breached: 1, unreached: 0 });
    expect(r1.errors.join(" ")).toMatch(/bell rows were not written .* the email was queued, so it is not sent again/);
    expect(s.db.tickets[0].sla_breached_at).toBe(iso(T0 + 5 * DAY));
    await runTicketSlaScan({ client: s.client, emit: e.emit, now: T0 + 6 * DAY });
    expect(e.sent).toHaveLength(1);
  });
  it("a transition between the read and the claim wins: the claim matches no row and nothing is sent", async () => {
    const s = store({ tickets: [row()], org_members: members, org_configurations: [], sla_defaults: [] });
    const realFrom = (s.client as unknown as { from: (t: string) => Record<string, unknown> }).from;
    let reads = 0;
    (s.client as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const q = realFrom(t);
      if (t === "tickets" && reads++ === 0) {
        // after the scan's read, the ticket moves on
        const then = q.then as (ok: (v: unknown) => unknown) => Promise<unknown>;
        q.then = (ok: (v: unknown) => unknown) => then((v: unknown) => { s.db.tickets[0].status = "PENDING_REVIEW"; return ok(v); });
      }
      return q;
    };
    const e = emitter();
    const r = await runTicketSlaScan({ client: s.client, emit: e.emit, now: T0 + 3.2 * DAY });
    expect(e.sent).toHaveLength(0);
    expect(r.warned).toBe(0);
    expect(s.db.tickets[0].sla_breach_warned_at).toBeNull();
  });
  it("an org whose members cannot be read sends nothing and stamps nothing — it is a line, never 'nobody to tell'", async () => {
    const s = store({ tickets: [row()], org_members: members, org_configurations: [], sla_defaults: [] }, { failRead: "org_members" });
    const e = emitter();
    const r = await runTicketSlaScan({ client: s.client, emit: e.emit, now: T0 + 5 * DAY });
    expect(e.sent).toHaveLength(0);
    expect(s.db.tickets[0].sla_breached_at).toBeNull();
    expect(r.errors.join(" ")).toMatch(/members could not be read/);
  });
  it("a ticket with no target is counted and never on the clock, unless its org configured sla_defaults for its type", async () => {
    const s = store({
      tickets: [row({ target_completion_at: null }), row({ id: "t2", target_completion_at: null, request_type: "MOC" })],
      org_members: members, org_configurations: [], sla_defaults: [{ org_id: "o1", request_type: "MOC", default_days: 2 }],
    });
    const e = emitter();
    const r = await runTicketSlaScan({ client: s.client, emit: e.emit, now: T0 + 3 * DAY });
    expect(r.noTarget).toBe(2); // both have no target of their own; only t2's org set a default for its type
    expect(r.breached).toBe(1);
    expect(e.sent.map((x) => x.resource.id)).toEqual(["t2"]);
  });
  it("the sla_defaults pass reads exactly the tickets whose stage is due (not-due and already-warned-not-yet-breached are never read)", async () => {
    const defaults = [{ org_id: "o1", request_type: "MOC", default_days: 4 }];
    const s = store({
      tickets: [
        row({ id: "n1", target_completion_at: null, request_type: "MOC", created_at: iso(T0 + 2 * DAY) }),                    // 1 day old of 4: not due
        row({ id: "w1", target_completion_at: null, request_type: "MOC", created_at: iso(T0) }),                              // 3.2 of 4: warn due
        row({ id: "w2", target_completion_at: null, request_type: "MOC", created_at: iso(T0), sla_breach_warned_at: iso(T0) }), // warned, breach not due
        row({ id: "b1", target_completion_at: null, request_type: "MOC", created_at: iso(T0 - 2 * DAY), sla_breach_warned_at: iso(T0) }), // breach due
      ],
      org_members: members, org_configurations: [], sla_defaults: defaults,
    });
    const e = emitter();
    const r = await runTicketSlaScan({ client: s.client, emit: e.emit, now: T0 + 3.2 * DAY });
    expect(r.scanned).toBe(2);
    expect(r).toMatchObject({ warned: 1, breached: 1, truncated: false });
    expect(e.sent.map((x) => [x.resource.id, x.metadata.sla])).toEqual([["b1", "breach"], ["w1", "warn"]]);
  });
  it("ended, archived and already-breached tickets are never read", async () => {
    const s = store({
      tickets: [row({ status: "CLOSED" }), row({ id: "t2", archived_at: iso(T0) }), row({ id: "t3", sla_breached_at: iso(T0) })],
      org_members: members, org_configurations: [], sla_defaults: [],
    });
    const r = await runTicketSlaScan({ client: s.client, emit: emitter().emit, now: T0 + 9 * DAY });
    expect(r.scanned).toBe(0);
  });
  it("pages by (target, id) — a breach stamped on one page cannot make the next page skip a row, and tied targets are all read", async () => {
    const tickets = Array.from({ length: 5 }, (_, i) => row({ id: `t${i}` })); // one target, five tickets
    const s = store({ tickets, org_members: members, org_configurations: [], sla_defaults: [] });
    const r = await runTicketSlaScan({ client: s.client, emit: emitter().emit, now: T0 + 9 * DAY, pageSize: 2 });
    expect(r.breached).toBe(5);
    expect(r.truncated).toBe(false);
    // warnings stay in the filter (not breached): the keyset still walks past them
    const w = store({ tickets: Array.from({ length: 5 }, (_, i) => row({ id: `w${i}` })), org_members: members, org_configurations: [], sla_defaults: [] });
    const rw = await runTicketSlaScan({ client: w.client, emit: emitter().emit, now: T0 + 3.2 * DAY, pageSize: 2 });
    expect(rw).toMatchObject({ warned: 5, scanned: 5, truncated: false });
  });
  it("ROUTE-9 / EDGE-7 done-when 1: more open tickets than one run reads never starves a due one — soonest-due first, and the second run reaches the rest", async () => {
    // Ids that sort FIRST belong to tickets due far in the future; the due
    // ones sort last. Reading by id with a cap of 3 would read only a*, every run.
    const later = Array.from({ length: 4 }, (_, i) => row({ id: `a${i}`, target_completion_at: iso(T0 + 60 * DAY) }));
    const due = Array.from({ length: 5 }, (_, i) => row({ id: `z${i}`, target_completion_at: iso(T0 + 4 * DAY + i * 60_000) }));
    const s = store({ tickets: [...later, ...due], org_members: members, org_configurations: [], sla_defaults: [] });
    const e = emitter();
    const r1 = await runTicketSlaScan({ client: s.client, emit: e.emit, now: T0 + 9 * DAY, pageSize: 2, maxTickets: 3 });
    expect(r1).toMatchObject({ breached: 3, truncated: true });
    const r2 = await runTicketSlaScan({ client: s.client, emit: e.emit, now: T0 + 9.1 * DAY, pageSize: 2, maxTickets: 3 });
    expect(r2.breached).toBe(2);
    expect(e.sent.map((x) => x.resource.id).sort()).toEqual(["z0", "z1", "z2", "z3", "z4"]);
    expect(s.db.tickets.filter((t) => String(t.id).startsWith("a")).every((t) => t.sla_breached_at === null && t.sla_breach_warned_at === null)).toBe(true);
  });
  it("source: the scan orders soonest-due first and never restarts from the lowest id", () => {
    const src2 = src("lib/ticketSla.ts");
    expect(src2).toContain('.order("target_completion_at", { ascending: true }).order("id", { ascending: true })');
    expect(src2).toContain("target_completion_at.gt.${pgq(cursor.target)},and(target_completion_at.eq.${pgq(cursor.target)},id.gt.${cursor.id})");
  });
});

describe("GAP-106 — the cron step (no new cron entry; one hunk in the maintenance route)", () => {
  it("vercel.json still schedules exactly the two crons", () => {
    const v = JSON.parse(src("vercel.json")) as { crons: unknown[] };
    expect(v.crons).toHaveLength(2);
  });
  it("step 5b runs the scan under the service role through emit(), bounded, its lines reported", () => {
    const r = src("app/api/cron/maintenance/route.ts");
    expect(r).toContain('import { runTicketSlaScan, type SlaScanReport } from "@/lib/ticketSla";');
    expect(r).toContain("const sla = await runTicketSlaScan({");
    expect(r).toContain("emit: (input) => runWithServerClient(sb, () => emit(input)),");
    expect(r).toContain("deadlineAt: Math.min(Date.now() + TICKET_SLA_MS, runEnd),");
    expect(r.match(/runTicketSlaScan\(/g)).toHaveLength(1);
    // before the compliance digest, so its emails ride the 6c drain
    expect(r.indexOf("const sla = await runTicketSlaScan({")).toBeLessThan(r.indexOf("result.complianceEmails = await queueComplianceDigests("));
  });
  it("the scan claims every stamp with .select(\"id\") and reads the count (a write that cannot silently fail)", () => {
    const s = src("lib/ticketSla.ts");
    expect(s).toContain('.eq("id", t.id).eq("status", t.status).is(column, null).select("id");');
    expect(s).toContain("if (!claimed || (claimed as unknown[]).length === 0) return; // another run, or a transition, got there first");
  });
});
