// drafting-flow Round G, DF-P3 ROUTING fix pass 2 — the SLA step's share of
// the maintenance cron's run (GAP-106 / EDGE-7). Driven through the REAL cron
// handler over the in-memory PostgREST stand-in of maintenanceDrain.test.ts
// (copied, not shared: that file is the notifications package's), with the
// real lib/ticketSla.ts scan and a faked clock: each SLA claim "takes" time,
// so the scan runs until its deadline.
//
// Pinned: the scan stops TICKET_SLA_RESERVE_MS (the compliance digest's floor
// + the second drain's reserve + the embed drain's minimum) before the run's
// end, so on a day the steps before it ran long it never takes the time the
// steps after it are guaranteed; with too little left it is not run, and
// says so; the steps after it still run.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => {
  process.env.CRON_SECRET = "cron-secret";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
  return {
    tables: {} as Record<string, Row[]>,
    calls: [] as Array<{ table: string; op: string; args: unknown[] }>,
    readError: {} as Record<string, { message: string } | undefined>,
    writeError: {} as Record<string, { message: string } | undefined>,
    seq: 0,
    /** PostgREST's max-rows: a non-head select returns at most this many rows
     *  (the count stays exact). null = no cap. */
    maxRows: null as number | null,
    /** Called on every executed query (table, op) — a test's clock or probe. */
    onExec: null as null | ((table: string, op: string) => void),
    /** RPCs that answer (by name); any other is "missing" (PGRST202). */
    rpcs: {} as Record<string, unknown>,
    /** Folded intake digests the flush hands to the cron's send. */
    folded: [] as Array<Record<string, unknown>>,
  };
});

/** A row's value at a PostgREST column path ("metadata->>key" reads the key as text). */
const at = (r: Row, k: string): unknown => {
  const m = /^(\w+)->>(\w+)$/.exec(k);
  if (!m) return r[k];
  const v = (r[m[1]] as Record<string, unknown> | null | undefined)?.[m[2]];
  return v == null ? null : String(v);
};

function makeClient() {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const orders: Array<[string, boolean]> = [];
    let limit = Infinity;
    let range: [number, number] | null = null;
    let head = false;
    let op = "select";
    let payload: unknown = null;
    let onConflict: string | null = null;
    let ignoreDuplicates = false;
    const matching = () => (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const exec = (): { data: unknown; error: unknown; count?: number } => {
      db.calls.push({ table, op: `exec:${op}`, args: [] });
      db.onExec?.(table, op);
      if (op === "select") {
        const err = db.readError[table];
        if (err) return { data: null, error: err };
        let rows = matching();
        for (const [k, asc] of [...orders].reverse()) {
          rows = [...rows].sort((a, b) => (String(at(a, k)) < String(at(b, k)) ? -1 : String(at(a, k)) > String(at(b, k)) ? 1 : 0) * (asc ? 1 : -1));
        }
        const count = rows.length;
        if (range) rows = rows.slice(range[0], range[1] + 1);
        if (limit !== Infinity) rows = rows.slice(0, limit);
        if (db.maxRows !== null) rows = rows.slice(0, db.maxRows);
        return { data: head ? null : rows.map((r) => ({ ...r })), error: null, count };
      }
      const err = db.writeError[table];
      if (err) return { data: null, error: err };
      if (op === "insert") {
        const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
        const landed = list.map((r) => ({ id: `${table}-${++db.seq}`, created_at: new Date().toISOString(), ...r }));
        db.tables[table] = [...(db.tables[table] ?? []), ...landed];
        return { data: landed, error: null };
      }
      if (op === "upsert") {
        const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
        for (const r of list) {
          const key = onConflict ?? "id";
          const hit = (db.tables[table] ?? []).find((x) => x[key] === r[key]);
          if (hit) { if (!ignoreDuplicates) Object.assign(hit, r); } else db.tables[table] = [...(db.tables[table] ?? []), { ...r }];
        }
        return { data: list, error: null };
      }
      if (op === "update") {
        const rows = matching();
        for (const r of rows) Object.assign(r, payload as Row);
        return { data: rows.map((r) => ({ ...r })), error: null };
      }
      const gone = matching();
      db.tables[table] = (db.tables[table] ?? []).filter((r) => !gone.includes(r));
      return { data: gone, error: null, count: gone.length };
    };
    const b: Record<string, unknown> = {};
    const p: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (res: (v: unknown) => void, rej?: (e: unknown) => void) => Promise.resolve(exec()).then(res, rej);
        return (...args: unknown[]) => {
          db.calls.push({ table, op: prop, args });
          switch (prop) {
            case "select": if (op === "select") head = !!(args[1] as { head?: boolean } | undefined)?.head; break;
            case "insert": case "update": case "delete": op = prop; payload = args[0]; break;
            case "upsert": op = "upsert"; payload = args[0]; onConflict = (args[1] as { onConflict?: string } | undefined)?.onConflict ?? null; ignoreDuplicates = !!(args[1] as { ignoreDuplicates?: boolean } | undefined)?.ignoreDuplicates; break;
            case "eq": filters.push((r) => at(r, String(args[0])) === args[1]); break;
            case "neq": filters.push((r) => at(r, String(args[0])) !== args[1]); break;
            case "in": { const s = new Set(args[1] as unknown[]); filters.push((r) => s.has(at(r, String(args[0])))); break; }
            case "is": filters.push((r) => (args[1] === null ? at(r, String(args[0])) == null : at(r, String(args[0])) === args[1])); break;
            case "gt": filters.push((r) => String(at(r, String(args[0]))) > String(args[1])); break;
            case "gte": filters.push((r) => String(at(r, String(args[0]))) >= String(args[1])); break;
            case "lt": filters.push((r) => String(at(r, String(args[0]))) < String(args[1])); break;
            case "lte": filters.push((r) => String(at(r, String(args[0]))) <= String(args[1])); break;
            case "not":
              if (args[1] === "is" && args[2] === null) filters.push((r) => at(r, String(args[0])) != null);
              else if (args[1] === "in") { const s = new Set(String(args[2]).replace(/^\(|\)$/g, "").split(",")); filters.push((r) => !s.has(String(at(r, String(args[0]))))); }
              break;
            case "contains": { const want = args[1] as Row; filters.push((r) => Object.entries(want).every(([k, v]) => (r[String(args[0])] as Row | null)?.[k] === v)); break; }
            case "order": orders.push([String(args[0]), (args[1] as { ascending?: boolean } | undefined)?.ascending !== false]); break;
            case "limit": limit = Number(args[0]); break;
            case "range": range = [Number(args[0]), Number(args[1])]; break;
            case "maybeSingle": case "single": {
              const out = exec();
              const rows = (out.data as Row[] | null) ?? [];
              return Promise.resolve({ data: out.error ? null : rows[0] ?? null, error: out.error });
            }
            default: break;
          }
          return new Proxy(b, p);
        };
      },
    };
    return new Proxy(b, p);
  };
  return {
    from,
    rpc: async (fn: string) => (Object.hasOwn(db.rpcs, fn)
      ? { data: db.rpcs[fn], error: null }
      : { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } }),
    auth: { getUser: async () => ({ data: { user: null } }) },
  };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeClient() }));
vi.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: makeClient() }));
vi.mock("@/lib/supabase", () => ({
  supabase: makeClient(),
  __setServerSupabaseClient: () => {},
  __resetServerSupabaseClient: () => {},
  __registerScopedServerClient: () => {},
}));
vi.mock("@/lib/projects", () => ({ autoReleaseExpiredAdHoc: async () => 0 }));
vi.mock("@/lib/storageAlerts", () => ({ runStorageAlerts: async () => ({ alerts: 0 }) }));
vi.mock("@/lib/reviewCycles", () => ({ scanAndNotifyReviews: async () => 0 }));
vi.mock("@/lib/acknowledgments", () => ({ scanAndNotifyAcks: async () => 0 }));
vi.mock("@/lib/reviewControl", () => ({ scanReviews: async () => 0 }));
vi.mock("@/lib/effectiveDate", () => ({ scanEffectiveDates: async () => 0 }));
vi.mock("@/lib/retention", () => ({ scanRetention: async () => 0 }));
vi.mock("@/lib/accessRecert", () => ({ scanAccessRecerts: async () => 0 }));
vi.mock("@/lib/distributionAcks", () => ({ scanDistributionAcks: async () => 0 }));
vi.mock("@/lib/holds", () => ({ scanStaleHolds: async () => 0 }));
vi.mock("@/lib/knowledgeSourceSync", () => ({ syncAllKnowledgeSources: async () => ({ libraries: 0, added: 0, refreshed: 0, removed: 0, deferred: 0, unsynced: 0, errors: [] }) }));
vi.mock("@/lib/knowledgeIngest", () => ({ drainKnowledgeIngestQueue: async () => ({ docsTouched: 0, pagesIndexed: 0, completed: 0, errors: [] }) }));
vi.mock("@/lib/knowledgeEmbedDrain", () => ({ drainEmbedBacklog: async () => ({ drained: [] }) }));
vi.mock("@/lib/orchestrator/proposals", () => ({ pruneOrchestratorProposals: async () => 0 }));
vi.mock("@/lib/storageUsage", () => ({ runPlatformStorageAlerts: async () => ({ status: { r2: { pct: 0 }, db: { pct: 0 } }, alerts: 0 }) }));
vi.mock("@/lib/aclIndexRebuild", () => ({ rebuildAclIndexes: async () => ({ errors: [] }) }));
vi.mock("@/lib/intakeStaging", () => ({ sweepIntakeStaging: async () => ({ objectsDeleted: 0, errors: [], truncated: false }) }));
// The intake helpers keep their contracts (lib/intakeRateLimit.ts): the flush
// hands each folded digest to `send`; deliverFoldedDigest lands the bell rows,
// then runs the email leg and only logs its failure; nudgeReviewHealth counts
// a `send` that throws as failed.
vi.mock("@/lib/intakeRateLimit", () => ({
  flushFoldedIntakeNotices: async (_c: unknown, input: { send: (d: Record<string, unknown>) => Promise<number> }) => {
    let digests = 0;
    for (const d of db.folded) if ((await input.send(d)) > 0) digests += 1;
    return { digests, failed: 0, unrecorded: 0 };
  },
  deliverFoldedDigest: async (_c: unknown, d: Record<string, unknown>, email?: (d: Record<string, unknown>) => Promise<void>) => {
    if (email) { try { await email(d); } catch { /* the real one logs and keeps the bell rows */ } }
    return 1;
  },
  foldedDigestKind: () => "doc_superseded", foldedDigestMetadata: () => ({}),
  nudgeReviewHealth: async (_c: unknown, input: { orgs: Array<{ orgId: string | null }>; send: (h: unknown, text: unknown, metadata: unknown) => Promise<void> }) => {
    const out = { nudged: 0, skipped: 0, failed: 0, orgless: 0 };
    for (const o of input.orgs) {
      if (!o.orgId) { out.orgless += 1; continue; }
      try { await input.send(o, { title: "t", body: "b" }, {}); out.nudged += 1; } catch { out.failed += 1; }
    }
    return out;
  },
  REVIEW_HEALTH_KIND: "review_overdue",
  isMissingFunction: () => true,
}));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => ({ recipients: 0 })) }));
vi.mock("@/lib/serverAuth", () => ({
  authorizeOrgRole: vi.fn(async () => ({ userId: "dc1", email: "dc1@x.io", orgId: "oA", role: "DocCtrl", roles: ["DocCtrl"], admin: makeClient() })),
}));

import { GET as cronGET } from "@/app/api/cron/maintenance/route";
import { emit } from "@/lib/notify/dispatch";


const runCron = async () => {
  const res = await cronGET(new NextRequest("http://cron.local/api/cron/maintenance", { headers: { authorization: "Bearer cron-secret" } }));
  expect(res.status).toBe(200);
  return res.json() as Promise<Record<string, unknown> & { errors: string[]; ticketSla?: Record<string, unknown> }>;
};

/** RUN_BUDGET_MS (maxDuration 300 s) less RUN_TAIL_MS (10 s). */
const RUN_MS = 290_000;
/** DIGEST_FLOOR_MS + AFTER_DIGEST_RESERVE_MS + EMBED_DRAIN_MIN_MS. */
const RESERVE_MS = 60_000 + 40_000 + 20_000;
/** What one SLA claim "takes" on the faked clock. */
const CLAIM_MS = 2_000;
const ORG = "oA";
const DAY = 86_400_000;
const savedFetch = globalThis.fetch;

beforeEach(() => {
  db.tables = { orgs: [{ id: ORG, name: "Org A" }] };
  db.calls = []; db.readError = {}; db.writeError = {}; db.seq = 0; db.maxRows = null; db.onExec = null; db.rpcs = {}; db.folded = [];
  vi.mocked(emit).mockReset();
  vi.mocked(emit).mockImplementation(async (input: unknown) => {
    const n = ((input as { audience?: { involved?: string[] } }).audience?.involved ?? []).length;
    return { recipients: n, inapp: { sent: n, failed: 0 } } as never;
  });
  process.env.NEXT_PUBLIC_SITE_URL = "https://ops.example.com";
  globalThis.fetch = vi.fn(async (url: unknown) => {
    if (String(url).endsWith("/api/notifications/send-queued")) {
      return new Response(JSON.stringify({ processed: 0 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  }) as typeof fetch;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** 200 open requests in org A, all past their target (each one a breach due). */
const seedOverdue = (now: number) => {
  db.tables.org_members = [
    { org_id: ORG, uid: "sup-1", status: "active", role: "DraftingSupervisor", roles: ["DraftingSupervisor"], email: "s@a.io" },
    { org_id: ORG, uid: "req-1", status: "active", role: "Requester", roles: ["Requester"], email: "r@a.io" },
  ];
  db.tables.org_configurations = [];
  db.tables.sla_defaults = [];
  db.tables.tickets = Array.from({ length: 200 }, (_, i) => ({
    id: `t${String(i).padStart(3, "0")}`, org_id: ORG, ticket_id: `REQ-${i}`, title: "Iso", status: "PENDING_ASSIGNMENT", request_type: "ISO",
    requester_id: "req-1", assigned_drafter_id: null, assigned_engineer_id: null, archived_at: null, outcome: null,
    created_at: new Date(now - 20 * DAY).toISOString(), target_completion_at: new Date(now - DAY + i * 1000).toISOString(),
    sla_breach_warned_at: null, sla_breached_at: null,
  }));
};

describe("GAP-106 fix pass 2 — step 5b never takes the time the steps after it are guaranteed", () => {
  it("the steps before it ran long (160 s): the scan stops RESERVE before the run's end — the digest's floor, the second drain's reserve and the embed drain's minimum are left — and the steps after it run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-10-13T03:00:00.000Z");
    vi.setSystemTime(start);
    seedOverdue(start);
    let jumped = false;
    let leftAtCompliance: number | null = null;
    db.onExec = (table, op) => {
      // step 4 (the intents prune) runs before 5b: it "takes" 160 s
      if (table === "document_intents" && !jumped) { jumped = true; vi.setSystemTime(Date.now() + 160_000); }
      // each SLA claim takes CLAIM_MS
      if (table === "tickets" && op === "update") vi.setSystemTime(Date.now() + CLAIM_MS);
      // step 6's first read: the moment the steps after 5b begin
      if (table === "orgs" && leftAtCompliance === null) leftAtCompliance = start + RUN_MS - Date.now();
    };
    const r = await runCron();
    expect(jumped).toBe(true);
    // the scan ran, and ran out of time (200 claims at 2 s would need 400 s)
    expect(r.ticketSla).toMatchObject({ clockStarted: true, truncated: true });
    expect(Number(r.ticketSla!.breached)).toBeGreaterThan(0);
    // before fix pass 2 the scan ran to min(now + 30 s, run end): 190 s in, leaving 100 s — less than RESERVE
    expect(leftAtCompliance).not.toBeNull();
    expect(leftAtCompliance!).toBeGreaterThanOrEqual(RESERVE_MS - CLAIM_MS);
    // and the steps after it still ran
    expect(r.errors.filter((e) => e.startsWith("compliance-digest"))).toEqual([]);
    expect(r.embedDrain).toBeDefined();
    expect(r.errors.some((e) => e.startsWith("embed-drain: not run"))).toBe(false);
  });

  it("with too little of the run left for its own share, the scan is not run — no ticket is read — and the line says why; the steps after it run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-10-13T03:00:00.000Z");
    vi.setSystemTime(start);
    seedOverdue(start);
    let jumped = false;
    db.onExec = (table) => { if (table === "document_intents" && !jumped) { jumped = true; vi.setSystemTime(Date.now() + 170_000); } };
    const r = await runCron();
    expect(r.ticketSla).toBeUndefined();
    expect(r.errors.some((e) => /^ticket-sla: not run — \d+ s of the run were left, and it stops 120 s before the run's end so the compliance digest, the second drain and the embed drain keep their time/.test(e))).toBe(true);
    expect(db.calls.some((c) => c.table === "tickets")).toBe(false);
    expect(db.tables.tickets.every((t) => t.sla_breached_at === null)).toBe(true);
    expect(r.embedDrain).toBeDefined();
  });

  it("an ordinary day: the scan sends every breach due, and the run is otherwise unchanged", async () => {
    seedOverdue(Date.now());
    db.tables.tickets = db.tables.tickets.slice(0, 3);
    const r = await runCron();
    expect(r.ticketSla).toMatchObject({ clockStarted: true, breached: 3, truncated: false });
    expect(vi.mocked(emit)).toHaveBeenCalledTimes(3);
    expect(r.embedDrain).toBeDefined();
    expect(r.platformStorage).toBeDefined();
  });
});
