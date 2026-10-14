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
import { ticketStatusLabel } from "@/lib/ticketStatusLabels";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SLA_WARN_FRACTION, SLA_CLOCK_COLUMN, effectiveTarget, warnAt, slaStage, waitingParty, slaRecipients, slaNotice,
  usedPercent, waitsOnRequester, runTicketSlaScan, type SlaTicket, type SlaEmitInput,
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
    const n = slaNotice(tk(), "breach", T0 + 4 * DAY, "UTC", T0 + 5 * DAY);
    expect(n.title).toBe("Overdue · REQ-1 Pump iso");
    expect(n.body).toMatch(/was due .*and is still waiting at the “Drafting” stage/); // UI-7 (DF-P14): the stage in words
    expect(slaNotice(tk(), "warn", T0 + 4 * DAY, "UTC", T0 + 3 * DAY).title).toBe("Due soon · REQ-1 Pump iso");
  });
});

describe("GAP-106 fix pass 2 — the notice's words follow the status family and the time actually used", () => {
  const target = T0 + 4 * DAY;
  it("a breach waiting on the DRAFTING side asks for a reassignment (drafter, engineer, the queue)", () => {
    for (const status of ["DRAFTING", "REVISION_REQ", "PENDING_IFC", "PENDING_ENG_TEAM", "PENDING_FINAL_APPROVAL", "PENDING_ASSIGNMENT"]) {
      const n = slaNotice(tk({ status, assignedEngineerId: "e-1" }), "breach", target, "UTC", T0 + 5 * DAY);
      expect(waitsOnRequester(status), status).toBe(false);
      expect(n.body, status).toContain(`is still waiting at the “${ticketStatusLabel(status)}” stage. Reassign it, or tell the requester when it will be done.`);
    }
  });
  it("a breach waiting on the REQUESTER (their review, their acknowledgement) never asks anyone to reassign it, nor the requester to tell themselves", () => {
    const review = slaNotice(tk({ status: "PENDING_REVIEW" }), "breach", target, "UTC", T0 + 5 * DAY);
    expect(review.body).toContain("is waiting at the “In review” stage, on the requester's review. Nothing needs reassigning: the requester's review moves it on.");
    const ack = slaNotice(tk({ status: "FINAL_DRAFT" }), "breach", target, "UTC", T0 + 5 * DAY);
    expect(ack.body).toContain("is waiting at the “Issued — awaiting acknowledgement” stage, on the requester's acknowledgement.");
    for (const n of [review, ack]) {
      expect(n.body).not.toMatch(/Reassign/);
      expect(n.body).not.toMatch(/tell the requester/);
    }
    expect(slaNotice(tk({ status: "FINAL_DRAFT" }), "warn", target, "UTC", T0 + 3 * DAY).body).toContain("It is waiting at the “Issued — awaiting acknowledgement” stage, on the requester's acknowledgement.");
  });
  it("the warning says the share of the window used NOW — 75 % on time, 97 % when found late — never a fixed 75 %", () => {
    expect(slaNotice(tk(), "warn", target, "UTC", T0 + 3 * DAY).body).toContain("has used 75% of its time");
    expect(slaNotice(tk(), "warn", target, "UTC", T0 + 3.88 * DAY).body).toContain("has used 97% of its time");
    // floored, and never "100 %" on a warning (it is not yet due)
    expect(usedPercent(tk(), target, T0 + 3.999 * DAY)).toBe(99);
    expect(slaNotice(tk(), "warn", target, "UTC", T0 + 3.9999 * DAY).body).toContain("has used 99% of its time");
    // an unknown or empty window names no share at all
    expect(usedPercent(tk({ createdAt: null }), target, T0 + 3 * DAY)).toBeNull();
    expect(slaNotice(tk({ createdAt: null }), "warn", target, "UTC", T0 + 3 * DAY).body).toMatch(/^This request is due [^.]+\. It is waiting at the “Drafting” stage\.$/);
    expect(slaNotice(tk(), "warn", target, "UTC", T0 + 3 * DAY).body).not.toContain(String(Math.round(SLA_WARN_FRACTION * 100)) + "% of its time. It is waiting at the “Drafting” stage. Reassign");
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
function store(seed: Record<string, RowT[]>, opts: { failRead?: string; missingColumn?: string; failClockRead?: boolean } = {}) {
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
    let columns = "";
    const run = () => {
      if (opts.failRead === table && !patch) return { data: null, error: { message: `${table} unreadable` } };
      if (!patch && opts.missingColumn && columns.split(",").map((c) => c.trim()).includes(opts.missingColumn)) {
        return { data: null, error: { code: "42703", message: `column ${table}.${opts.missingColumn} does not exist` } };
      }
      if (!patch && opts.failClockRead && columns === SLA_CLOCK_COLUMN) return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
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
      select: (c?: string, o?: { head?: boolean }) => { wantRows = true; columns = c ?? ""; if (o?.head) head = true; return q; },
      update: (p: RowT) => { patch = p; return q; },
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
      is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return q; },
      gt: (k: string, v: unknown) => { filters.push((r) => String(r[k]) > String(v)); return q; },
      lte: (k: string, v: unknown) => { filters.push((r) => r[k] !== null && r[k] !== undefined && String(r[k]) <= String(v)); return q; },
      lt: (k: string, v: unknown) => { filters.push((r) => r[k] !== null && r[k] !== undefined && String(r[k]) < String(v)); return q; },
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
      // read 0 is the clock check (has 20261195 been pasted?); read 1 is the scan's page
      if (t === "tickets" && reads++ === 1) {
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
  it("the scan words the warning with the share used when it ran (a ticket reached late says so)", async () => {
    const s = store({ tickets: [row()], org_members: members, org_configurations: [], sla_defaults: [] });
    const e = emitter();
    await runTicketSlaScan({ client: s.client, emit: e.emit, now: T0 + 3.6 * DAY });
    expect(e.sent[0].body).toContain("has used 90% of its time");
  });
  it("a run past its deadline after the targeted pass does not start the sla_defaults pass", async () => {
    const s = store({
      tickets: [row({ id: "n1", target_completion_at: null, request_type: "MOC" })],
      org_members: members, org_configurations: [], sla_defaults: [{ org_id: "o1", request_type: "MOC", default_days: 1 }],
    });
    const r = await runTicketSlaScan({ client: s.client, emit: emitter().emit, now: T0 + 5 * DAY, deadlineAt: Date.now() - 1 });
    expect(r).toMatchObject({ truncated: true, breached: 0 });
    expect(s.reads).not.toContain("sla_defaults");
  });
  it("source: the scan orders soonest-due first and never restarts from the lowest id", () => {
    const src2 = src("lib/ticketSla.ts");
    expect(src2).toContain('.order("target_completion_at", { ascending: true }).order("id", { ascending: true })');
    expect(src2).toContain("target_completion_at.gt.${pgq(cursor.target)},and(target_completion_at.eq.${pgq(cursor.target)},id.gt.${cursor.id})");
  });
});

describe("GAP-106 fix pass 2 — the clock starts at the paste of 20261195: before it the backlog is counted, never mailed", () => {
  const backlog = () => [
    row({ id: "old1", target_completion_at: iso(T0 - 300 * DAY), created_at: iso(T0 - 314 * DAY) }),
    row({ id: "old2", status: "FINAL_DRAFT", target_completion_at: iso(T0 - 30 * DAY), created_at: iso(T0 - 44 * DAY) }),
    row({ id: "soon", target_completion_at: iso(T0 + 9 * DAY) }),
  ];
  it("tickets.outcome not there yet (20261195 not pasted): nothing is sent or stamped — the open requests past their target are counted and the line says the paste starts the clock", async () => {
    const s = store({ tickets: backlog(), org_members: members, org_configurations: [], sla_defaults: [] }, { missingColumn: "outcome" });
    const e = emitter();
    const r = await runTicketSlaScan({ client: s.client, emit: e.emit, now: T0 });
    expect(e.sent).toHaveLength(0);
    expect(s.writes).toHaveLength(0);
    expect(r).toMatchObject({ clockStarted: false, overdueBeforeClock: 2, scanned: 0, warned: 0, breached: 0 });
    expect(r.errors).toEqual(["ticket-sla: the SLA clock starts when 20261195 is pasted — nothing was sent. 2 open request(s) are already past their target; the paste records them as overdue without a notice each and tells each workspace's assignment queue once."]);
    // no read of the members, the configuration or the defaults: the counts only
    expect(s.reads.filter((t) => t !== "tickets")).toEqual([]);
  });
  it("after the paste (the column is there, the backlog stamped by it) the scan runs as before", async () => {
    const stamped = backlog().map((t) => (t.id === "soon" ? t : { ...t, sla_breached_at: iso(T0 - 1), sla_breach_warned_at: iso(T0 - 1) }));
    const s = store({ tickets: stamped, org_members: members, org_configurations: [], sla_defaults: [] });
    const e = emitter();
    const r = await runTicketSlaScan({ client: s.client, emit: e.emit, now: T0 + 7 * DAY });
    expect(r.clockStarted).toBe(true);
    expect(e.sent.map((x) => [x.resource.id, x.metadata.sla])).toEqual([["soon", "warn"]]);
  });
  it("whether the clock started cannot be read (any other error): nothing is sent, and it says so", async () => {
    const s = store({ tickets: backlog(), org_members: members, org_configurations: [], sla_defaults: [] }, { failClockRead: true });
    const e = emitter();
    const r = await runTicketSlaScan({ client: s.client, emit: e.emit, now: T0 });
    expect(e.sent).toHaveLength(0);
    expect(r.clockStarted).toBe(false);
    expect(r.errors.join(" ")).toMatch(/whether the SLA clock has started could not be read — no SLA notice was sent/);
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
    // fix pass 2: it stops before what the later steps are guaranteed
    expect(r).toContain("const slaDeadlineAt = Math.min(Date.now() + TICKET_SLA_MS, runEnd - TICKET_SLA_RESERVE_MS);");
    expect(r).toContain("const TICKET_SLA_RESERVE_MS = DIGEST_FLOOR_MS + AFTER_DIGEST_RESERVE_MS + EMBED_DRAIN_MIN_MS;");
    expect(r).toContain("deadlineAt: slaDeadlineAt,");
    expect(r).not.toContain("deadlineAt: Math.min(Date.now() + TICKET_SLA_MS, runEnd),");
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

// drafting-flow EDGE-17 (Round G, DF-P13 — built here by the integrator's
// ruling, DEC-90): the sla_defaults pass skips a stored window outside the
// create route's bound (lib/notifications.ts boundedSlaDays — whole days, 1 to
// SLA_DEFAULT_DAYS_MAX; 20261218's CHECK) exactly as it passes over a type with
// no row, and says so in one line per workspace. Every in-bound row is read
// exactly as before.
describe("EDGE-17 — the sla_defaults pass never uses a stored window outside boundedSlaDays, and one workspace's row never stops it for the next", () => {
  const membersOf = (org: string) => members.map((m) => ({ ...m, org_id: org }));
  const untargeted = (over: RowT = {}) => row({ target_completion_at: null, request_type: "MOC", created_at: iso(T0), ...over });
  /** The store's client, every query-builder call recorded as [table, method, ...args]. */
  function recorded(s: ReturnType<typeof store>) {
    const calls: Array<[string, string, ...unknown[]]> = [];
    const base = s.client as unknown as { from: (t: string) => Record<string, unknown> };
    const from = (table: string) => {
      const q = base.from(table);
      const p: Record<string, unknown> = new Proxy(q, {
        get(target, prop: string) {
          const v = target[prop];
          if (typeof v !== "function" || prop === "then" || prop === "maybeSingle") return v;
          return (...args: unknown[]) => {
            calls.push([table, prop, ...args]);
            const out = (v as (...a: unknown[]) => unknown)(...args);
            return out === target ? p : out;
          };
        },
      });
      return p;
    };
    return { client: { from } as unknown as RoutingClient, calls };
  }

  it("a 2,000,000,000-day row in one workspace (read first) beside a valid row in another: the second workspace's due ticket is still stamped and notified; the first is one line, never a throw", async () => {
    const s = store({
      tickets: [untargeted({ id: "bad1", org_id: "o0" }), untargeted({ id: "ok1", org_id: "o2" })],
      org_members: [...membersOf("o0"), ...membersOf("o2")], org_configurations: [],
      sla_defaults: [{ org_id: "o0", request_type: "MOC", default_days: 2000000000 }, { org_id: "o2", request_type: "MOC", default_days: 2 }],
    });
    const e = emitter();
    const r = await runTicketSlaScan({ client: s.client, emit: e.emit, now: T0 + 3 * DAY });
    expect(e.sent.map((x) => [x.orgId, x.resource.id, x.metadata.sla])).toEqual([["o2", "ok1", "breach"]]);
    expect(s.db.tickets.find((t) => t.id === "ok1")).toMatchObject({ sla_breached_at: iso(T0 + 3 * DAY), sla_breach_warned_at: iso(T0 + 3 * DAY) });
    expect(s.db.tickets.find((t) => t.id === "bad1")).toMatchObject({ sla_breached_at: null, sla_breach_warned_at: null });
    expect(r).toMatchObject({ breached: 1, warned: 0, truncated: false });
    expect(r.errors).toEqual([
      "ticket-sla@o0: 1 sla_defaults window(s) outside 1–3650 whole days were not used — the open requests of those types with no due date of their own are not timed, as for a type with no window, until the window is corrected (Admin → Request forms)",
    ]);
    // the line carries the workspace id and a count — never the type or the value
    expect(r.errors[0]).not.toContain("MOC");
    expect(r.errors[0]).not.toContain("2000000000");
  });

  it("a row outside the bound — 0, -1, 3651, 5000, 2,000,000,000, a fraction, text, null — is passed over exactly as a type with no row: the same reads, writes and notices; only the one line differs", async () => {
    const seed = (moc: RowT[]) => ({
      tickets: [
        untargeted({ id: "m-old", created_at: iso(T0 - 4000 * DAY) }),   // past any window up to 4000 days
        untargeted({ id: "m-new" }),
        untargeted({ id: "i-due", request_type: "ISO" }),
      ],
      org_members: members, org_configurations: [],
      sla_defaults: [...moc, { org_id: "o1", request_type: "ISO", default_days: 2 }],
    });
    const run = async (moc: RowT[]) => {
      const s = store(seed(moc));
      const rec = recorded(s);
      const e = emitter();
      const r = await runTicketSlaScan({ client: rec.client, emit: e.emit, now: T0 + 3 * DAY });
      return { r, sent: e.sent, tickets: s.db.tickets, ticketCalls: rec.calls.filter((c) => c[0] === "tickets") };
    };
    const none = await run([]);
    expect(none.sent.map((x) => x.resource.id)).toEqual(["i-due"]);
    expect(none.r.errors).toEqual([]);
    for (const bad of [0, -1, 3651, 5000, 2000000000, 1.5, "x", null]) {
      const got = await run([{ org_id: "o1", request_type: "MOC", default_days: bad }]);
      expect(got.sent, String(bad)).toEqual(none.sent);
      expect(got.tickets, String(bad)).toEqual(none.tickets);
      expect(got.ticketCalls, String(bad)).toEqual(none.ticketCalls);
      expect(got.r, String(bad)).toEqual({ ...none.r, errors: [expect.stringMatching(/^ticket-sla@o1: 1 sla_defaults window\(s\) outside 1–3650 whole days were not used/)] });
    }
  });

  it("every in-bound row is read exactly as before: its window as stored (a number, or PostgREST's text for one), the warn and breach filters the clock always computed, and no line", async () => {
    const now = T0 + 3 * DAY;
    for (const stored of [1, 2, 4, 14, 3650, "7"] as const) {
      const days = Number(stored);
      const s = store({
        tickets: [untargeted({ created_at: iso(now - days * DAY * 0.8) })],   // past the warning point, inside the window
        org_members: members, org_configurations: [],
        sla_defaults: [{ org_id: "o1", request_type: "MOC", default_days: stored }],
      });
      const rec = recorded(s);
      const e = emitter();
      const r = await runTicketSlaScan({ client: rec.client, emit: e.emit, now });
      // before EDGE-17 the pass took Number(default_days) for any positive value: the same instants, to the millisecond
      const warnFrom = new Date(now - days * DAY * SLA_WARN_FRACTION).toISOString();
      const breachFrom = new Date(now - days * DAY).toISOString();
      const pass = rec.calls.filter((c) => c[0] === "tickets" && c[1] === "lte" && c[2] === "created_at");
      expect(pass, String(stored)).toEqual([["tickets", "lte", "created_at", warnFrom]]);
      expect(rec.calls, String(stored)).toContainEqual(["tickets", "or", `sla_breach_warned_at.is.null,created_at.lte."${breachFrom}"`]);
      expect(e.sent.map((x) => [x.resource.id, x.metadata.sla, x.metadata.target]), String(stored)).toEqual([["t1", "warn", new Date(T0 + 3 * DAY - days * DAY * 0.8 + days * DAY).toISOString()]]);
      expect(r.errors, String(stored)).toEqual([]);
    }
  });

  it("source: the pass reads every row as before, bounds it with boundedSlaDays (the create route's helper — no second bound in the clock), and its line names a workspace and a count", () => {
    const c = src("lib/ticketSla.ts");
    expect(c).toContain('const { data: defs, error: defErr } = await sb.from("sla_defaults").select("org_id, request_type, default_days");');
    expect(c).toContain("const days = boundedSlaDays(d.default_days);");
    expect(c).not.toContain("Number(d.default_days) > 0");
    expect(c).toContain("report.errors.push(`ticket-sla@${orgId}: ${n} sla_defaults window(s) outside 1–${SLA_DEFAULT_DAYS_MAX} whole days were not used");
  });
});
