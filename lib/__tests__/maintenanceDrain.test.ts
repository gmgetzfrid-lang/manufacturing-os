// notifications Round G — N6 EMAIL-PIPELINE-AND-CRON: the drain, the digest,
// the escalation, the one-click unsubscribe, the purge and the attribution
// migration — driven through the REAL route handlers over an in-memory
// PostgREST stand-in (the sweepRoundD3 Proxy-chain pattern, with filters,
// ordering and limits applied, so a query's shape decides what it returns).
//
//   DELIV-11   the drain loop reads `processed`; unconfigured email, failed
//              sends and the second pass are reported, never read as an empty
//              queue.
//   NEDGE-17   the compliance digest reads each (org, recipient) on its own:
//              a flood of one org's browser-legal compliance rows cannot push
//              another org's lines out.
//   NEDGE-9    the digest honours 'never' and the master switch through the
//              shared rule, and lists unread items only.
//   NEDGE-4    the digest links the Inbox, absolute.
//   NEDGE-12   the escalation's date and the digest's name carry their zone.
//   DELIV-7    the escalation's and the digest's failed writes are reported.
//   NEDGE-10   the drain attaches the signed one-click List-Unsubscribe header
//              and the footer to member mail — the header only for mail to
//              the recipient's own address that the master switch stops (a
//              forged row naming another uid gets none, and its link would
//              not verify); the unsubscribe route works.
//   NEDGE-17   (fix pass) the digest's cost follows the pending items: a
//              member with nothing pending is never read; its deadline is
//              derived from the run's start.
//   NEDGE-17   (fix pass 2) the digest always gets its floor of time, a run
//              cut short or skipped loses nothing (the next run's window
//              reaches back to the oldest item still owed), and successive
//              short runs reach every recipient in turn (a resume cursor);
//              the background steps take what the run has left.
//   DELIV-7    (fix pass 2) the cron's two emit() calls read what they reached.
//   DELIV-8    the purge lists abandoned (suppressed) mail as its own line,
//              with an exact breakdown past the API's row cap, and records it
//              BEFORE deleting it; read rows carrying a dedupe watermark are
//              kept.
//   DELIV-1    20261183's one-paste shape.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
import { POST as drainPOST } from "@/app/api/notifications/send-queued/route";
import { GET as unsubGET, POST as unsubPOST } from "@/app/api/notifications/unsubscribe/route";
import { GET as purgeGET, POST as purgePOST } from "@/app/api/admin/purge/route";
import { signUnsubscribe } from "@/lib/unsubscribeToken";
import { emit } from "@/lib/notify/dispatch";

const ROOT = process.cwd();
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
const ORIGIN = "https://ops.example.com";
const ORG_A = "oA", ORG_B = "oB";
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const BDC = U(900);   // org B's Document Controller

const runCron = async () => {
  const res = await cronGET(new NextRequest("http://cron.local/api/cron/maintenance", { headers: { authorization: "Bearer cron-secret" } }));
  expect(res.status).toBe(200);
  return res.json() as Promise<Record<string, unknown> & { errors: string[] }>;
};
const rows = (t: string) => db.tables[t] ?? [];
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** Queue the drain's answers, one per send-queued call, in order (then: empty). */
let drainAnswers: Array<{ status?: number; body?: unknown }> = [];
let drainCalls = 0;
let resendBodies: Array<Record<string, unknown>> = [];
let resendStatus: number[] = [];
/** How long each send-queued batch "takes" on the faked clock (0: no time). */
let drainTakesMs = 0;
const savedFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  db.tables = { orgs: [{ id: ORG_A, name: "Org A" }, { id: ORG_B, name: "Org B" }] };
  db.calls = []; db.readError = {}; db.writeError = {}; db.seq = 0; db.maxRows = null; db.onExec = null; db.rpcs = {}; db.folded = [];
  drainAnswers = []; drainCalls = 0; resendBodies = []; resendStatus = []; drainTakesMs = 0;
  vi.mocked(emit).mockReset();
  vi.mocked(emit).mockImplementation(async () => ({ recipients: 0 }));
  for (const k of ["NEXT_PUBLIC_SITE_URL", "VERCEL_PROJECT_PRODUCTION_URL", "NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL", "RESEND_API_KEY", "EMAIL_UNSUBSCRIBE_SECRET"]) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  process.env.NEXT_PUBLIC_SITE_URL = ORIGIN;
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/api/notifications/send-queued")) {
      drainCalls += 1;
      if (drainTakesMs) vi.setSystemTime(new Date(Date.now() + drainTakesMs));
      const a = drainAnswers.shift() ?? { body: { processed: 0 } };
      return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.resend.com/emails") {
      resendBodies.push(JSON.parse(String(init?.body)));
      const s = resendStatus.shift() ?? 200;
      return new Response(s === 200 ? "{}" : "bad gateway", { status: s });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  vi.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
describe("DELIV-11 — the drain loop reads `processed`; a failed or unconfigured drain is never an empty queue", () => {
  it("{processed:100, sent:0, failed:100} is reported — count and a provider message — and the loop stops (another batch would burn the same rows' attempts)", async () => {
    drainAnswers = [{ body: { processed: 100, sent: 0, failed: 100, errorSample: "Resend 502: bad gateway" } }];
    const r = await runCron();
    expect(r.notificationsDrained).toBe(0);
    expect(r.emailDrain).toEqual({ batches: 1, attempted: 100, sent: 0, failed: 100, configured: true, deferred: null, queueEmpty: false });
    expect(r.errors).toContain("notifications: 100 of 100 send attempt(s) failed — e.g. Resend 502: bad gateway");
    // step 2 stopped after that batch; the second pass found the queue empty
    expect(drainCalls).toBe(2);
  });

  it("configured:false surfaces as a field and an error naming the backlog; the second pass does not repeat it", async () => {
    drainAnswers = [{ body: { processed: 0, sent: 0, failed: 0, deferred: 37, configured: false } }];
    const r = await runCron();
    expect(r.emailDrain).toMatchObject({ configured: false, deferred: 37, queueEmpty: false });
    expect(r.errors).toContain("notifications: email is not configured (RESEND_API_KEY is not set) — 37 email(s) left queued, none sent");
    expect(r.emailDrainAfterDigest).toBeUndefined();
    expect(drainCalls).toBe(1);
  });

  it("an empty queue is textually distinct: queueEmpty, no drain error", async () => {
    const r = await runCron();
    expect(r.emailDrain).toEqual({ batches: 1, attempted: 0, sent: 0, failed: 0, configured: true, deferred: null, queueEmpty: true });
    expect(r.errors.filter((e) => e.startsWith("notifications"))).toEqual([]);
  });

  it("partial failure: the loop continues while mail goes out, totals add up, the failures are reported", async () => {
    drainAnswers = [
      { body: { processed: 100, sent: 100, failed: 0 } },
      { body: { processed: 3, sent: 2, failed: 1, errorSample: "Resend 422: invalid to" } },
      { body: { processed: 0 } },
    ];
    const r = await runCron();
    expect(r.notificationsDrained).toBe(102);
    expect(r.emailDrain).toMatchObject({ batches: 3, attempted: 103, sent: 102, failed: 1, queueEmpty: true });
    expect(r.errors).toContain("notifications: 1 of 103 send attempt(s) failed — e.g. Resend 422: invalid to");
  });

  it("the second pass (6c) reports instead of swallowing", async () => {
    drainAnswers = [{ body: { processed: 0 } }, { status: 500 }];
    const r = await runCron();
    expect(r.errors).toContain("notifications (after the compliance steps): HTTP 500");
    const route = src("app/api/cron/maintenance/route.ts");
    expect(route).not.toMatch(/catch \{ \/\* the daily drain will catch up \*\/ \}/);
    expect(route).not.toMatch(/body\?\.sent \?\? body\?\.processed/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
const member = (org: string, uid: string, status = "active", email: string | null = `${uid.slice(-4)}@${org}.io`) =>
  ({ org_id: org, uid, status, email, role: "Engineer", roles: null });
const notice = (org: string, uid: string, kind: string, title: string, created: string, over: Row = {}) =>
  ({ id: `n-${++db.seq}`, org_id: org, user_id: uid, kind, title, link: "/documents/l?doc=d", created_at: created, read_at: null, metadata: null, ...over });
const digests = () => rows("email_notifications").filter((e) => e.event_type === "compliance_digest");
const digestFor = (uid: string) => digests().find((e) => e.to_user_id === uid);

describe("NEDGE-17 — each recipient's digest is read on its own: one org's flood cannot push another org's lines out", () => {
  it("2,400 browser-legal ack_requested rows in org A (600 to each of four colleagues) — org B's Document Controller still gets every one of their lines", async () => {
    const colleagues = [U(1), U(2), U(3), U(4)];
    db.tables.org_members = [member(ORG_A, U(99)), ...colleagues.map((u) => member(ORG_A, u)), member(ORG_B, BDC)];
    db.tables.notifications = [notice(ORG_B, BDC, "review_due", "Review due: PID-0001", minutesAgo(60))];
    for (const u of colleagues) for (let i = 0; i < 600; i++) {
      db.tables.notifications.push(notice(ORG_A, u, "ack_requested", `Please acknowledge DOC-${i}`, minutesAgo(30), { actor_user_id: U(99) }));
    }
    // tonight's scans write org B's obligations last, as the service role
    db.tables.notifications.push(notice(ORG_B, BDC, "ack_overdue", "Overdue acknowledgment: PID-0002", minutesAgo(1)));
    db.tables.notifications.push(notice(ORG_B, BDC, "review_overdue", "Review overdue: PID-0003", minutesAgo(1)));

    const r = await runCron();
    const d = digestFor(BDC)!;
    expect(d).toBeTruthy();
    for (const t of ["Review due: PID-0001", "Overdue acknowledgment: PID-0002", "Review overdue: PID-0003"]) expect(String(d.body_text)).toContain(t);
    expect(d.subject).toBe("Compliance items need you (3)");
    // each flooded colleague's own digest counts their rows exactly, and lists a capped set
    const c1 = digestFor(U(1))!;
    expect(c1.subject).toBe("Compliance items need you (600)");
    expect(String(c1.body_text)).toMatch(/…and 588 more/);
    expect(r.complianceEmails).toBe(5);
    // each list read is scoped to its recipient's org and uid — one per recipient
    // with something pending; U(99), who has nothing pending, is never read
    const scopedUids = db.calls.filter((c) => c.table === "notifications" && c.op === "eq" && c.args[0] === "user_id").map((c) => c.args[1]);
    expect(scopedUids.sort()).toEqual([...colleagues, BDC].sort());
    expect(db.calls.filter((c) => c.table === "notifications" && c.op === "eq" && c.args[0] === "org_id")).toHaveLength(5);
  });

  it("the API's row cap below the discovery page (max-rows 500) drops nobody: a short page is never read as the last", async () => {
    db.maxRows = 500;
    const colleagues = [U(1), U(2), U(3), U(4)];
    db.tables.org_members = [...colleagues.map((u) => member(ORG_A, u)), member(ORG_B, BDC)];
    db.tables.notifications = [];
    for (const u of colleagues) for (let i = 0; i < 600; i++) {
      db.tables.notifications.push(notice(ORG_A, u, "ack_requested", `Please acknowledge DOC-${i}`, minutesAgo(30)));
    }
    db.tables.notifications.push(notice(ORG_B, BDC, "ack_overdue", "Overdue acknowledgment: PID-0002", minutesAgo(1)));
    const r = await runCron();
    expect(r.complianceEmails).toBe(5);
    expect(String(digestFor(BDC)!.body_text)).toContain("Overdue acknowledgment: PID-0002");
  });
});

describe("NEDGE-17 (fix pass) — the digest's cost follows the pending items, and its deadline the run's clock", () => {
  it("300 members, one with an unread compliance item: one list read, one membership read, one preferences read — nobody else is touched", async () => {
    db.tables.org_members = Array.from({ length: 300 }, (_, i) => member(i % 2 ? ORG_A : ORG_B, U(i + 1)));
    db.tables.notifications = [notice(ORG_A, U(2), "review_due", "Due", minutesAgo(10)), notice(ORG_A, U(3), "ticket_comment", "Not compliance", minutesAgo(10))];
    const r = await runCron();
    expect(r.complianceEmails).toBe(1);
    expect(digestFor(U(2))).toBeTruthy();
    expect(db.calls.filter((c) => c.table === "notifications" && c.op === "eq" && c.args[0] === "user_id").map((c) => c.args[1])).toEqual([U(2)]);
    // the membership read names the recipients; no whole-platform member page
    const memberIns = db.calls.filter((c) => c.table === "org_members" && c.op === "in");
    expect(memberIns.some((c) => c.args[0] === "uid" && JSON.stringify(c.args[1]) === JSON.stringify([U(2)]))).toBe(true);
    expect(db.calls.some((c) => c.table === "org_members" && c.op === "range")).toBe(false);
    const prefIns = db.calls.filter((c) => c.table === "notification_preferences" && c.op === "in");
    expect(prefIns.map((c) => c.args[1])).toEqual([[U(2)]]);
  });

  it("REGRESSION (fix pass 2): earlier steps that take 120 s still leave the digest its time — the pending recipient's digest is queued", async () => {
    db.tables.org_members = [member(ORG_A, U(1))];
    db.tables.notifications = [notice(ORG_A, U(1), "review_due", "Due A", minutesAgo(10))];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    let jumped = false;
    // step 4 (the intents prune) runs before the digest: it "takes" 120 s
    db.onExec = (table) => { if (table === "document_intents" && !jumped) { jumped = true; vi.setSystemTime(new Date(Date.now() + 120_000)); } };
    try {
      const r = await runCron();
      expect(jumped).toBe(true);
      expect(r.complianceEmails).toBe(1);
      expect(String(digestFor(U(1))!.body_text)).toContain("Due A");
      expect(r.errors.filter((e) => e.startsWith("compliance-digest"))).toEqual([]);
      // and the background steps after it still had their time
      expect(r.embedDrain).toBeDefined();
      expect(r.platformStorage).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("earlier steps that leave only 10 s: the digest still composes (its floor, cut to the run's end); the second drain and the background steps give way and say so; the two prunes still run", async () => {
    db.tables.org_members = [member(ORG_A, U(1))];
    db.tables.notifications = [notice(ORG_A, U(1), "review_due", "Due A", minutesAgo(10))];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    let jumped = false;
    db.onExec = (table) => { if (table === "document_intents" && !jumped) { jumped = true; vi.setSystemTime(new Date(Date.now() + 280_000)); } };
    try {
      const r = await runCron();
      expect(r.complianceEmails).toBe(1);
      expect(r.errors).toContain("notifications (after the compliance steps): not run — the run's time is spent; the queue is sent by the next drain");
      expect(r.emailDrainAfterDigest).toMatchObject({ batches: 0, outOfTime: true });
      for (const step of ["knowledge-sync", "knowledge-ingest", "platform-storage", "embed-drain"]) {
        expect(r.errors.some((e) => e.startsWith(`${step}: not run — 10 s of the run were left`)), step).toBe(true);
      }
      expect(r.embedDrain).toBeUndefined();
      expect(r.platformStorage).toBeUndefined();
      expect(r).toHaveProperty("folderTrashPurged");
      expect(r.orchestratorProposalsPruned).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("LOSSLESS: a run whose earlier steps used the whole run composes nothing and says so — and the next day's run lists the item, though it is then more than 25 hours old", async () => {
    db.tables.org_members = [member(ORG_A, U(1))];
    vi.useFakeTimers({ toFake: ["Date"] });
    const day1 = new Date("2026-10-01T03:00:00.000Z");
    vi.setSystemTime(day1);
    db.tables.notifications = [notice(ORG_A, U(1), "review_due", "Due on day 1", new Date(day1.getTime() - 10 * 60_000).toISOString())];
    let jumped = false;
    db.onExec = (table) => { if (table === "document_intents" && !jumped) { jumped = true; vi.setSystemTime(new Date(Date.now() + 295_000)); } };
    try {
      const r1 = await runCron();
      expect(r1.complianceEmails).toBe(0);
      expect(digests()).toEqual([]);
      expect(r1.errors.some((e) => /^compliance-digest: nothing was composed — no time was left in this run \(the steps before it used 295 s of the 300 s\); nothing is lost/.test(e))).toBe(true);
      // the first window is recorded even so (a no-op when a state row exists)
      // (25 hours before the digest's own clock, 03:04:55)
      expect(rows("platform_settings")).toEqual([{ key: "compliance_digest", value: { openSince: "2026-09-30T02:04:55.000Z", after: null }, updated_at: "2026-10-01T03:04:55.000Z" }]);

      db.onExec = null;
      vi.setSystemTime(new Date("2026-10-02T04:00:00.000Z"));   // 25 h 10 min after the item
      const r2 = await runCron();
      expect(r2.complianceEmails).toBe(1);
      const d = digestFor(U(1))!;
      expect(String(d.body_text)).toContain("Due on day 1");
      expect(d.metadata).toMatchObject({ since: "2026-09-30T02:04:55.000Z", through: "2026-10-02T04:00:00.000Z" });
      // a complete run closes the window and leaves no cursor
      expect(rows("platform_settings")[0].value).toEqual({ openSince: "2026-10-02T04:00:00.000Z", after: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a deadline reached mid-run stops between rounds, names how many recipients were not reached, and records where it stopped", async () => {
    db.tables.org_members = Array.from({ length: 20 }, (_, i) => member(ORG_A, U(i + 1)));
    db.tables.notifications = Array.from({ length: 20 }, (_, i) => notice(ORG_A, U(i + 1), "review_due", `Due ${i}`, minutesAgo(10)));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    let lists = 0;
    // the first round's list reads "take" the rest of the time
    db.onExec = (table, op) => {
      if (table === "notifications" && op === "select" && db.calls.some((c) => c.table === "notifications" && c.op === "eq" && c.args[0] === "user_id")) {
        if (++lists === 1) vi.setSystemTime(new Date(Date.now() + 300_000));
      }
    };
    try {
      const r = await runCron();
      expect(r.complianceEmails).toBe(8);
      expect(r.errors.some((e) => /^compliance-digest: stopped at its deadline — 12 of 20 recipient\(s\) were not reached this run; the next run starts with them and its search reaches back to \S+, the oldest item still owed, so nothing is lost within 7 days$/.test(e))).toBe(true);
      expect(rows("platform_settings")[0].value).toMatchObject({ after: `${ORG_A}|${U(8)}` });
    } finally {
      vi.useRealTimers();
    }
  });

  it("MAJOR (fix pass 2): three runs cut short reach every recipient in turn — each one's day-1 item is listed once, by the run that reached them, even two days later; a complete fourth run closes the window", async () => {
    const N = 20;
    db.tables.org_members = Array.from({ length: N }, (_, i) => member(ORG_A, U(i + 1)));
    vi.useFakeTimers({ toFake: ["Date"] });
    const T = Date.parse("2026-10-01T03:00:00.000Z");
    vi.setSystemTime(new Date(T));
    db.tables.notifications = Array.from({ length: N }, (_, i) => notice(ORG_A, U(i + 1), "review_due", `Due ${i + 1}`, new Date(T - 10 * 60_000).toISOString()));
    // each run's first per-recipient list read "takes" the rest of the run: one round of 8
    const cutShort = () => {
      const mark = db.calls.length;
      let jumped = false;
      db.onExec = (table, op) => {
        if (jumped || table !== "notifications" || op !== "select") return;
        if (db.calls.slice(mark).some((c) => c.table === "notifications" && c.op === "eq" && c.args[0] === "user_id")) {
          jumped = true;
          vi.setSystemTime(new Date(Date.now() + 300_000));
        }
      };
    };
    const reachedBy: string[][] = [];
    try {
      for (let day = 0; day < 3; day++) {
        vi.setSystemTime(new Date(T + day * 86_400_000));
        cutShort();
        const before = new Set(digests().map((d) => String(d.to_user_id)));
        const r = await runCron();
        expect(r.complianceEmails, `day ${day + 1}`).toBe(day < 2 ? 8 : 4);
        reachedBy.push(digests().map((d) => String(d.to_user_id)).filter((u) => !before.has(u)));
      }
      // run 1: U1–U8; run 2: U9–U16; run 3: U17–U20 (and U1–U4 again, wrapping, with nothing new for them)
      expect(reachedBy[0]).toEqual(Array.from({ length: 8 }, (_, i) => U(i + 1)));
      expect(reachedBy[1]).toEqual(Array.from({ length: 8 }, (_, i) => U(i + 9)));
      expect(reachedBy[2]).toEqual(Array.from({ length: 4 }, (_, i) => U(i + 17)));
      for (let i = 1; i <= N; i++) {
        const mine = digests().filter((d) => d.to_user_id === U(i));
        expect(mine, `U(${i})`).toHaveLength(1);
        expect(String(mine[0].body_text)).toContain(`Due ${i}`);
        expect(mine[0].subject).toBe("Compliance items need you (1)");
      }
      // still owed after run 3: nobody's item — but U5–U16 were not reached by it, so the window stays open
      expect(rows("platform_settings")[0].value).toMatchObject({ openSince: new Date(T - 10 * 60_000 - 1).toISOString(), after: `${ORG_A}|${U(4)}` });

      db.onExec = null;
      vi.setSystemTime(new Date(T + 3 * 86_400_000));
      const r4 = await runCron();
      expect(r4.complianceEmails).toBe(0);
      expect(digests()).toHaveLength(N);
      expect(rows("platform_settings")[0].value).toEqual({ openSince: new Date(T + 3 * 86_400_000).toISOString(), after: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second run the same day (the per-day dedupe) keeps what it held back owed — the next day's digest lists it, and not what the first one already listed", async () => {
    db.tables.org_members = [member(ORG_A, U(1))];
    vi.useFakeTimers({ toFake: ["Date"] });
    const T = Date.parse("2026-10-01T03:00:00.000Z");
    vi.setSystemTime(new Date(T));
    db.tables.notifications = [notice(ORG_A, U(1), "review_due", "Item A", new Date(T - 60_000).toISOString())];
    try {
      await runCron();
      expect(digests()).toHaveLength(1);
      db.tables.notifications.push(notice(ORG_A, U(1), "ack_requested", "Item B", new Date(T + 5 * 60_000).toISOString()));
      vi.setSystemTime(new Date(T + 10 * 60_000));
      await runCron();
      expect(digests()).toHaveLength(1);
      expect(rows("platform_settings")[0].value).toMatchObject({ openSince: new Date(T + 5 * 60_000 - 1).toISOString(), after: null });
      vi.setSystemTime(new Date(T + 86_400_000));
      await runCron();
      expect(digests()).toHaveLength(2);
      const second = digests()[1];
      expect(String(second.body_text)).toContain("Item B");
      expect(String(second.body_text)).not.toContain("Item A");
      expect(second.subject).toBe("Compliance items need you (1)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a state that cannot be read: the digest is still sent, each list starting where that person's last digest stopped; nothing is recorded", async () => {
    db.tables.org_members = [member(ORG_A, U(1))];
    vi.useFakeTimers({ toFake: ["Date"] });
    const T = Date.parse("2026-10-05T03:00:00.000Z");
    vi.setSystemTime(new Date(T));
    db.tables.email_notifications = [{ id: "old", org_id: ORG_A, to_user_id: U(1), event_type: "compliance_digest", status: "sent", created_at: new Date(T - 2 * 86_400_000).toISOString(), metadata: { day: "2026-10-03", through: new Date(T - 2 * 86_400_000).toISOString() } }];
    db.tables.notifications = [
      notice(ORG_A, U(1), "review_due", "Already listed", new Date(T - 2 * 86_400_000 - 60_000).toISOString()),
      notice(ORG_A, U(1), "review_due", "Thirty hours old", new Date(T - 30 * 3_600_000).toISOString()),
    ];
    db.readError.platform_settings = { message: "boom" };
    try {
      const r = await runCron();
      expect(r.errors.some((e) => e.startsWith("compliance-digest: where the last run stopped could not be read — this run searches the last 7 days"))).toBe(true);
      const d = digests().find((e) => e.id !== "old")!;
      expect(String(d.body_text)).toContain("Thirty hours old");
      expect(String(d.body_text)).not.toContain("Already listed");
      expect(db.calls.some((c) => c.table === "platform_settings" && c.op === "upsert")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a recorded state this run cannot parse: it searches the lookback, says so, and records a valid state in its place", async () => {
    db.tables.org_members = [member(ORG_A, U(1))];
    db.tables.platform_settings = [{ key: "compliance_digest", value: { openSince: "not a time" } }];
    db.tables.notifications = [notice(ORG_A, U(1), "review_due", "Thirty hours old", new Date(Date.now() - 30 * 3_600_000).toISOString())];
    const r = await runCron();
    expect(r.errors.some((e) => e.startsWith("compliance-digest: the recorded state (platform_settings 'compliance_digest') is not one this run can read"))).toBe(true);
    expect(String(digestFor(U(1))!.body_text)).toContain("Thirty hours old");
    const v = rows("platform_settings")[0].value as { openSince: string; after: string | null };
    expect(Number.isFinite(Date.parse(v.openSince))).toBe(true);
    expect(v.after).toBeNull();
  });

  it("step 2 starts no batch that could end after its share of the run: a backlog of 40-second batches stops after three and says so; the digest still runs", async () => {
    db.tables.org_members = [member(ORG_A, U(1))];
    db.tables.notifications = [notice(ORG_A, U(1), "review_due", "Due A", minutesAgo(10))];
    drainAnswers = Array.from({ length: 20 }, () => ({ body: { processed: 100, sent: 100, failed: 0 } }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    drainTakesMs = 40_000;
    try {
      const r = await runCron();
      expect(r.emailDrain).toMatchObject({ batches: 3, sent: 300, outOfTime: true, queueEmpty: false });
      expect(r.errors).toContain("notifications: stopped at its time limit after 3 batch(es) (300 sent) — the rest of the queue is sent by the next drain");
      expect(r.complianceEmails).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the clock by source: the digest's deadline is the run's end less the second drain's reserve, never less than its floor; the background budgets come from what is left", () => {
    const route = src("app/api/cron/maintenance/route.ts");
    expect(route).toContain("const startedAt = Date.now();\n  const runEnd = startedAt + RUN_BUDGET_MS - RUN_TAIL_MS;");
    expect(route).toContain("return Math.min(runEnd, Math.max(runEnd - AFTER_DIGEST_RESERVE_MS, now + DIGEST_FLOOR_MS));");
    expect(route).toContain("deadlineAt: digestDeadlineAt(runEnd, Date.now()),");
    expect(route).toContain("const AFTER_DIGEST_RESERVE_MS = DRAIN_BATCH_MS + 10_000;");
    expect(route).toContain("budgetMs: Math.min(EMBED_DRAIN_MS, left())");
    expect(route).toContain("deadlineMs: Date.now() + Math.min(INGEST_MS, left() - INGEST_COMMIT_MS),");
    // no reservation for the background steps is held ahead of the digest, and no daily stride
    expect(route).not.toMatch(/100_000 \/\* embed drain \*\//);
    expect(route).not.toMatch(/% members\.length/);
    expect(route.indexOf("const startedAt = Date.now();")).toBeLessThan(route.indexOf("// 1. Sweep expired ad-hoc checkouts"));
  });
});

describe("DELIV-7 (fix pass 2) — the cron's emit() calls read what they reached", () => {
  const seedHealth = () => {
    db.rpcs = {
      prune_intake_attempts: 0,
      orphaned_in_review_versions_count: 1,
      pending_on_retired_version_count: 0,
      intake_review_health_by_org: [{ org_id: ORG_A, orphaned_in_review: 1, pending_on_retired: 0, example_document_id: "d1" }],
    };
  };

  it("a review-health nudge that reached no controller, or lost bell rows, is not counted as nudged and is named", async () => {
    seedHealth();
    const r = await runCron();
    expect(r.reviewHealthNudges).toBe(0);
    expect(r.errors).toContain("intake-door: 1 org(s) with review-health counts could not be nudged — oA: it reached no recipient (the audience resolved to nobody)");

    vi.mocked(emit).mockImplementation(async () => ({ recipients: 2, inapp: { sent: 1, failed: 1 } }));
    const r2 = await runCron();
    expect(r2.reviewHealthNudges).toBe(0);
    expect(r2.errors).toContain("intake-door: 1 org(s) with review-health counts could not be nudged — oA: 1 of 2 bell row(s) were refused");

    vi.mocked(emit).mockImplementation(async () => ({ recipients: 2, inapp: { sent: 2, failed: 0 } }));
    const r3 = await runCron();
    expect(r3.reviewHealthNudges).toBe(1);
    expect(r3.errors.filter((e) => e.includes("could not be nudged"))).toEqual([]);
  });

  it("a folded intake digest whose email leg reached nobody is a line (its bell rows landed)", async () => {
    db.rpcs = { prune_intake_attempts: 0 };
    db.folded = [{ orgId: ORG_A, projectId: "p1", involved: [U(1)], title: "t", body: "b", link: "/projects/p1", actorName: "System" }];
    const r = await runCron();
    expect(r.intakeFoldedDigests).toBe(1);
    expect(r.errors).toContain("intake-notices: project p1 — the digest's email leg: it reached no recipient (the audience resolved to nobody)");
    vi.mocked(emit).mockImplementation(async () => ({ recipients: 1 }));
    const r2 = await runCron();
    expect(r2.errors.filter((e) => e.startsWith("intake-notices: project"))).toEqual([]);
  });

  it("by source: neither emit() in the cron discards its result", () => {
    const route = src("app/api/cron/maintenance/route.ts");
    expect(route).not.toContain(".then(() => undefined)");
    expect((route.match(/emitShortfall\(r, "(inapp|email)"\)/g) ?? []).length).toBe(2);
  });
});

describe("NEDGE-9 — the digest honours the member's preferences and lists unread items only", () => {
  const seedThree = () => {
    db.tables.org_members = [member(ORG_A, U(1)), member(ORG_A, U(2)), member(ORG_A, U(3)), member(ORG_A, U(4), "suspended")];
    db.tables.notifications = [
      notice(ORG_A, U(1), "review_due", "Due A", minutesAgo(10)),
      notice(ORG_A, U(2), "review_due", "Due B", minutesAgo(10)),
      notice(ORG_A, U(3), "review_due", "Due C (read)", minutesAgo(10), { read_at: minutesAgo(5) }),
      notice(ORG_A, U(3), "ack_requested", "Ack C", minutesAgo(10)),
      notice(ORG_A, U(4), "review_due", "Due suspended", minutesAgo(10)),
      notice(ORG_A, U(1), "ticket_comment", "Not compliance", minutesAgo(10)),
      notice(ORG_A, U(1), "review_due", "Too old", minutesAgo(26 * 60)),
    ];
  };

  it("digest_frequency 'never' and the master switch silence it; a row with neither mails; a read item is not listed; a suspended member gets none", async () => {
    seedThree();
    db.tables.notification_preferences = [
      { user_id: U(1), email_enabled: true, digest_frequency: "never" },
      { user_id: U(2), email_enabled: false, digest_frequency: "instant" },
    ];
    await runCron();
    expect(digestFor(U(1))).toBeUndefined();
    expect(digestFor(U(2))).toBeUndefined();
    const c = digestFor(U(3))!;
    expect(String(c.body_text)).toContain("Ack C");
    expect(String(c.body_text)).not.toContain("Due C (read)");
    expect(c.subject).toBe("Compliance items need you (1)");
    expect(digestFor(U(4))).toBeUndefined();
    // the cron uses the app's one email rule — not a private copy
    const route = src("app/api/cron/maintenance/route.ts");
    expect(route).toContain('emailAllowedByPrefs(prefs.get(m.uid) ?? null, "compliance_digest")');
    expect(route).not.toMatch(/select\("user_id, email_enabled"\)/);
  });

  it("REGRESSION: no preferences row = the defaults — the digest is sent as before; non-compliance and >25h rows are not listed", async () => {
    seedThree();
    await runCron();
    const a = digestFor(U(1))!;
    expect(String(a.body_text)).toContain("Due A");
    expect(String(a.body_text)).not.toContain("Not compliance");
    expect(String(a.body_text)).not.toContain("Too old");
    expect(a.to_email).toBe(`${U(1).slice(-4)}@${ORG_A}.io`);
    expect(a.metadata).toMatchObject({ day: new Date().toISOString().slice(0, 10), count: 1 });
  });

  it("an unreadable preferences read sends the digest stamped pref_gate=unverified, and says so (DEC-74 §4)", async () => {
    seedThree();
    db.readError.notification_preferences = { message: "boom" };
    const r = await runCron();
    expect(digestFor(U(1))!.metadata).toMatchObject({ pref_gate: "unverified" });
    expect(r.errors.some((e) => e.startsWith("compliance-digest: the email preferences of 3 member(s) could not be read"))).toBe(true);
  });

  it("the per-(org, user, day) dedupe is preserved: a second run the same day mails nobody twice", async () => {
    seedThree();
    await runCron();
    const first = digests().length;
    expect(first).toBe(3);
    await runCron();
    expect(digests().length).toBe(first);
  });

  it("DELIV-7: a digest insert that fails is a line in errors and is not counted", async () => {
    seedThree();
    db.writeError.email_notifications = { message: "permission denied" };
    const r = await runCron();
    expect(r.complianceEmails).toBe(0);
    expect(r.errors.filter((e) => /compliance-digest: oA\/.*: the digest was not queued — the next run lists these items again: permission denied/.test(e))).toHaveLength(3);
    // what was not queued stays owed: the window does not move past it
    expect((rows("platform_settings")[0].value as { openSince: string }).openSince < new Date(Date.now() - 9 * 60_000).toISOString()).toBe(true);
  });
});

describe("NEDGE-4 / NEDGE-12 — the digest links the Inbox, absolute, and is named for when it was composed", () => {
  it("every href is absolute; the Inbox link rides the row; the body names the window's end with its zone (UTC)", async () => {
    db.tables.org_members = [member(ORG_A, U(1))];
    db.tables.notifications = [notice(ORG_A, U(1), "review_due", "Due A", minutesAgo(10))];
    await runCron();
    const d = digestFor(U(1))!;
    const hrefs = [...String(d.body_html).matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([`${ORIGIN}/inbox`, `${ORIGIN}/settings/notifications`]);
    expect(String(d.body_text)).toContain(`Open your Inbox to act on them: ${ORIGIN}/inbox`);
    expect(d.metadata).toMatchObject({ link: `${ORIGIN}/inbox`, rendered: true });
    expect(String(d.body_text)).toMatch(/notices from \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00 \(UTC\) to \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00 \(UTC\)\./);
    expect(String(d.body_html)).toContain("Org A");
  });

  it("an org with a configured zone (org_configurations key 'timezone') is named in it", async () => {
    db.tables.org_members = [member(ORG_A, U(1))];
    db.tables.notifications = [notice(ORG_A, U(1), "review_due", "Due A", minutesAgo(10))];
    db.tables.org_configurations = [{ org_id: ORG_A, key: "timezone", data: { timeZone: "America/Chicago" } }];
    await runCron();
    expect(String(digestFor(U(1))!.body_text)).toMatch(/[+-]0[56]:00 \(America\/Chicago\)\./);
  });

  it("COMPLIANCE_KINDS is the registry's compliance column — no hand list", () => {
    const route = src("app/api/cron/maintenance/route.ts");
    expect(route).toMatch(/const COMPLIANCE_KINDS: string\[\] = \(Object\.keys\(KIND_META\) as Array<keyof typeof KIND_META>\)\s*\.filter\(\(k\) => KIND_META\[k\]\.compliance\);/);
    expect(route).not.toMatch(/const COMPLIANCE_KINDS = \[/);
  });
});

describe("DELIV-7 / NEDGE-12 — the stale-checkout escalation reports a failed write and labels its date", () => {
  const seedStale = () => {
    db.tables.org_members = [member(ORG_A, U(1)), { ...member(ORG_A, U(7)), role: "DocCtrl" }];
    db.tables.checkout_sessions = [{ id: "s1", org_id: ORG_A, document_id: "d1", library_id: "l1", user_id: U(1), user_name: "Pat", started_at: "2026-03-20T23:15:15Z", purpose: "markups", status: "active" }];
  };

  it("the notice's body names the day with its zone (UTC) — never the server's bare toLocaleDateString()", async () => {
    seedStale();
    const r = await runCron();
    expect(r.staleEscalations).toBe(1);
    const n = rows("notifications").find((x) => x.kind === "checkout_released")!;
    expect(n.body).toBe("Pat has had a document checked out since 2026-03-20 (UTC) (markups). Nudge them or force-release if the work is done.");
    expect(n.metadata).toEqual({ staleSessionId: "s1", escalation: true });
  });

  it("an insert that fails is pushed into errors and the session is not counted (it is retried next run)", async () => {
    seedStale();
    db.writeError.notifications = { message: "insert refused" };
    const r = await runCron();
    expect(r.staleEscalations).toBe(0);
    expect(r.errors).toContain("stale-escalation: session s1 — the controllers' notice was not written (retried on the next run): insert refused");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("NEDGE-10 — the drain: a signed one-click List-Unsubscribe header and the footer on member mail; external mail as stored", () => {
  const drain = () => drainPOST(new Request("http://app.local/api/notifications/send-queued", { method: "POST", headers: { authorization: "Bearer cron-secret" } }));
  const queued = (over: Row) => ({ org_id: ORG_A, status: "queued", attempt_count: 0, subject: "S", body_text: "Body", body_html: null, created_at: minutesAgo(5), ...over });

  it("member mail carries List-Unsubscribe (signed for to_user_id at their own address) + List-Unsubscribe-Post; an unrendered row gets the footer at send; a rendered one is sent as stored; external mail gets neither", async () => {
    process.env.RESEND_API_KEY = "re_test";
    db.tables.users = [{ id: U(1), email: "a@x.io" }, { id: U(2), email: "B@X.io" }, { id: U(3), email: "sender@x.io" }];
    db.tables.email_notifications = [
      queued({ id: "e1", to_user_id: U(1), to_email: "a@x.io", body_text: `ping @[Mike](${U(5)})`, metadata: null }),
      queued({ id: "e2", to_user_id: U(2), to_email: "b@x.io", body_text: "rendered text", body_html: "<p>rendered</p>", metadata: { rendered: true } }),
      queued({ id: "e3", to_user_id: U(3), to_email: "contractor@ext.io", body_text: "portal", body_html: "<p>portal</p>", metadata: { external: true } }),
    ];
    const res = await drain();
    expect(await res.json()).toEqual({ processed: 3, sent: 3, failed: 0 });
    const byTo = new Map(resendBodies.map((b) => [b.to as string, b]));
    const a = byTo.get("a@x.io")!;
    const tokenA = signUnsubscribe(U(1), "a@x.io")!;
    expect(a.headers).toEqual({
      "List-Unsubscribe": `<${ORIGIN}/api/notifications/unsubscribe?u=${U(1)}&t=${encodeURIComponent(tokenA)}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(String(a.text)).toContain(`${ORIGIN}/settings/notifications`);
    expect(String(a.text)).toContain("Org A sent this notification.");
    expect(String(a.text)).toContain("ping @Mike");
    expect(String(a.text)).not.toContain(U(5));
    expect(String(a.html)).toContain(`href="${ORIGIN}/settings/notifications"`);
    const b = byTo.get("b@x.io")!;
    expect(b).toMatchObject({ text: "rendered text", html: "<p>rendered</p>" });
    expect((b.headers as Row)["List-Unsubscribe"]).toContain(`u=${U(2)}`);
    const ext = byTo.get("contractor@ext.io")!;
    expect(ext.headers).toBeUndefined();
    expect(ext).toMatchObject({ text: "portal", html: "<p>portal</p>" });
    // the stored rows were never rewritten
    expect(rows("email_notifications").find((r) => r.id === "e1")!.body_text).toBe(`ping @[Mike](${U(5)})`);
  });

  it("BLOCKER (fix pass): a forged row — to_user_id = the victim, to_email = the forger — is sent with NO unsubscribe header, and a link minted for that address turns nothing off", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const VICTIM = U(7);
    db.tables.users = [{ id: VICTIM, email: "victim@b.io" }, { id: U(8), email: "forger@a.io" }];
    // RLS admits this row (email_notif_insert checks the address against the
    // org's members, never against to_user_id) — reproduced on PG16 by the review
    db.tables.email_notifications = [
      queued({ id: "f1", to_user_id: VICTIM, to_email: "forger@a.io", body_text: "hi", metadata: { rendered: true } }),
      queued({ id: "ok", to_user_id: VICTIM, to_email: "victim@b.io", body_text: "real", metadata: { rendered: true } }),
    ];
    expect(await (await drain()).json()).toEqual({ processed: 2, sent: 2, failed: 0 });
    const byTo = new Map(resendBodies.map((b) => [b.to as string, b]));
    expect(byTo.get("forger@a.io")!.headers).toBeUndefined();
    expect(JSON.stringify(byTo.get("forger@a.io"))).not.toContain("/api/notifications/unsubscribe");
    // the victim's own mail still carries their link
    expect((byTo.get("victim@b.io")!.headers as Row)["List-Unsubscribe"]).toContain(`u=${VICTIM}`);
    // and a link signed for the forger's address (what a uid-only token gave them) does nothing
    const forged = `http://app.local/api/notifications/unsubscribe?u=${VICTIM}&t=${encodeURIComponent(signUnsubscribe(VICTIM, "forger@a.io")!)}`;
    const res = await unsubPOST(new NextRequest(forged, { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } }));
    expect(res.status).toBe(400);
    expect(rows("notification_preferences")).toEqual([]);
    expect((await unsubGET(new NextRequest(forged))).status).toBe(400);
  });

  it("no header on mail the master switch does not stop: recalls, PSM alerts, the transmittal's unstamped / refused notices, and anything to a member whose switch is already off; unreadable recipient facts withhold it (mail still sent)", async () => {
    process.env.RESEND_API_KEY = "re_test";
    db.tables.users = [1, 2, 3, 4, 5, 6].map((n) => ({ id: U(n), email: `u${n}@x.io` }));
    db.tables.notification_preferences = [{ user_id: U(5), email_enabled: false }];
    db.tables.email_notifications = [
      queued({ id: "r", to_user_id: U(1), to_email: "u1@x.io", event_type: "safety_recall", metadata: { rendered: true } }),
      queued({ id: "a", to_user_id: U(2), to_email: "u2@x.io", event_type: "safety_alert", metadata: { rendered: true } }),
      queued({ id: "t1", to_user_id: U(3), to_email: "u3@x.io", event_type: "transmittal_unstamped" }),
      queued({ id: "t2", to_user_id: U(4), to_email: "u4@x.io", event_type: "transmittal_refused" }),
      // the transmittal route's acknowledgment receipt: queued without a preference read
      queued({ id: "ack", to_user_id: U(5), to_email: "u5@x.io", event_type: "watcher_activity" }),
      queued({ id: "m", to_user_id: U(6), to_email: "u6@x.io", event_type: "comment_mention", metadata: { rendered: true } }),
    ];
    expect(await (await drain()).json()).toMatchObject({ processed: 6, sent: 6 });
    const head = (to: string) => resendBodies.find((b) => b.to === to)!.headers;
    for (const n of [1, 2, 3, 4, 5]) expect(head(`u${n}@x.io`)).toBeUndefined();
    expect((head("u6@x.io") as Row)["List-Unsubscribe"]).toContain(`u=${U(6)}`);

    resendBodies = [];
    db.tables.email_notifications = [queued({ id: "m2", to_user_id: U(6), to_email: "u6@x.io", event_type: "comment_mention", metadata: { rendered: true } })];
    db.readError.users = { message: "boom" };
    expect(await (await drain()).json()).toMatchObject({ processed: 1, sent: 1 });
    expect(resendBodies[0].headers).toBeUndefined();
  });

  it("a failed send returns a provider message for the cron (errorSample); the CAS claim and the 7-day recovery bound survive", async () => {
    process.env.RESEND_API_KEY = "re_test";
    resendStatus = [502];
    db.tables.email_notifications = [queued({ id: "e1", to_user_id: U(1), to_email: "a@x.io" })];
    const out = await (await drain()).json();
    expect(out).toMatchObject({ processed: 1, sent: 0, failed: 1 });
    expect(String(out.errorSample)).toMatch(/^Resend 502: bad gateway/);
    const route = src("app/api/notifications/send-queued/route.ts");
    expect(route).toMatch(/\.update\(\{ status: "sending", last_attempted_at: new Date\(\)\.toISOString\(\) \}\)\s*\n\s*\.in\("id", candidateIds\)\s*\n\s*\.in\("status", \["queued", "failed"\]\)\s*\n\s*\.select\("\*"\);/);
    expect(route).toMatch(/\.eq\("status", "suppressed"\)\s*\n\s*\.gte\("created_at", new Date\(Date\.now\(\) - 7 \* 24 \* 60 \* 60 \* 1000\)\.toISOString\(\)\);/);
  });

  it("REGRESSION: unconfigured email still defers the whole backlog untouched", async () => {
    db.tables.email_notifications = [queued({ id: "e1", to_user_id: U(1), to_email: "a@x.io" })];
    const out = await (await drain()).json();
    expect(out).toMatchObject({ processed: 0, sent: 0, failed: 0, deferred: 1, configured: false });
    expect(resendBodies).toEqual([]);
    expect(rows("email_notifications")[0].status).toBe("queued");
  });
});

describe("NEDGE-10 dw1 / dw3 — the one-click unsubscribe route", () => {
  const url = (uid: string, t: string) => `http://app.local/api/notifications/unsubscribe?u=${uid}&t=${encodeURIComponent(t)}`;
  const seedUsers = () => { db.tables.users = [{ id: U(1), email: "one@x.io" }, { id: U(2), email: "two@x.io" }]; };

  it("GET shows the choice and changes nothing (mail scanners fetch GET); the page names the mail that still arrives; a bad link is refused", async () => {
    seedUsers();
    const t = signUnsubscribe(U(1), "one@x.io")!;
    const res = await unsubGET(new NextRequest(url(U(1), t)));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<form method="post"');
    expect(html).toContain("drawing recalls and safety alerts");
    expect(html).toContain("the notices a transmittal sends the person who issued it");
    expect(rows("notification_preferences")).toEqual([]);
    expect((await unsubGET(new NextRequest(url(U(1), "forged")))).status).toBe(400);
    expect((await unsubGET(new NextRequest(url("not-a-uid", t)))).status).toBe(400);
  });

  it("the one-click POST turns email off for THAT member only (an upsert — a member with no row gets one, every other column at its default)", async () => {
    seedUsers();
    db.tables.notification_preferences = [{ user_id: U(2), email_enabled: true, digest_frequency: "instant" }];
    const res = await unsubPOST(new NextRequest(url(U(1), signUnsubscribe(U(1), "one@x.io")!), { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } }));
    expect(await res.json()).toEqual({ ok: true });
    expect(rows("notification_preferences").find((p) => p.user_id === U(1))).toMatchObject({ email_enabled: false });
    expect(rows("notification_preferences").find((p) => p.user_id === U(2))).toMatchObject({ email_enabled: true });
    const up = db.calls.find((c) => c.table === "notification_preferences" && c.op === "upsert")!;
    expect(Object.keys(up.args[0] as Row).sort()).toEqual(["email_enabled", "updated_at", "user_id"]);
    expect(up.args[1]).toEqual({ onConflict: "user_id" });
    // the page's answer does not promise more than the switch does
    const page = await unsubPOST(new NextRequest(url(U(1), signUnsubscribe(U(1), "one@x.io")!), { method: "POST", headers: { accept: "text/html" } }));
    const html = await page.text();
    expect(html).not.toContain("You will no longer receive notification emails");
    expect(html).toContain("the notices a transmittal sends the person who issued it");
  });

  it("another member's token, a token for another address, or a member who has since changed address, writes nothing; a refused write is a 500, never a fake success", async () => {
    seedUsers();
    const res = await unsubPOST(new NextRequest(url(U(1), signUnsubscribe(U(2), "two@x.io")!), { method: "POST" }));
    expect(res.status).toBe(400);
    expect((await unsubPOST(new NextRequest(url(U(1), signUnsubscribe(U(1), "two@x.io")!), { method: "POST" }))).status).toBe(400);
    const old = signUnsubscribe(U(1), "one@x.io")!;
    db.tables.users[0].email = "one.new@x.io";
    expect((await unsubPOST(new NextRequest(url(U(1), old), { method: "POST" }))).status).toBe(400);
    expect(rows("notification_preferences")).toEqual([]);
    db.tables.users[0].email = "one@x.io";
    db.writeError.notification_preferences = { message: "denied" };
    const res2 = await unsubPOST(new NextRequest(url(U(1), old), { method: "POST", headers: { accept: "text/html" } }));
    expect(res2.status).toBe(500);
    expect(await res2.text()).toContain("could not be saved");
  });

  it("an address that cannot be read changes nothing and says so (500, not 'invalid', not a success)", async () => {
    seedUsers();
    db.readError.users = { message: "boom" };
    const t = signUnsubscribe(U(1), "one@x.io")!;
    const res = await unsubPOST(new NextRequest(url(U(1), t), { method: "POST" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "the link could not be checked; nothing was changed" });
    expect((await unsubGET(new NextRequest(url(U(1), t)))).status).toBe(500);
    expect(rows("notification_preferences")).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("DELIV-8 — the purge: abandoned (suppressed) mail is its own reported line; watermark rows are kept", () => {
  const old = "2026-01-01T00:00:00.000Z";
  const seedPurge = () => {
    db.tables.email_notifications = [
      { id: "s1", org_id: ORG_A, status: "sent", created_at: old, event_type: "watcher_activity" },
      { id: "x1", org_id: ORG_A, status: "suppressed", created_at: old, event_type: "watcher_activity" },
      { id: "x2", org_id: ORG_A, status: "suppressed", created_at: "2026-01-05T00:00:00.000Z", event_type: "comment_mention" },
      { id: "f1", org_id: ORG_A, status: "failed", created_at: old, event_type: "sla_warning" },
    ];
    db.tables.notifications = [
      { id: "r1", org_id: ORG_A, kind: "ticket_comment", read_at: old, created_at: old, metadata: null },
      { id: "w1", org_id: ORG_A, kind: "checkout_released", read_at: old, created_at: old, metadata: { staleSessionId: "s9", escalation: true } },
      { id: "w2", org_id: ORG_A, kind: "hold_opened", read_at: old, created_at: old, metadata: { staleHoldId: "h1", staleFor: "x" } },
      { id: "w3", org_id: ORG_A, kind: "transmittal_unstampable", read_at: old, created_at: old, metadata: { documentId: "d1" } },
      { id: "u1", org_id: ORG_A, kind: "ticket_comment", read_at: null, created_at: old, metadata: null },
    ];
  };

  it("the preview lists delivered and abandoned mail as two lines; the abandoned line says how many, of which kinds, from when", async () => {
    seedPurge();
    const res = await purgeGET(new NextRequest("http://x/api/admin/purge?orgId=oA&days=30", { headers: { authorization: "Bearer t" } }));
    const json = await res.json() as { targets: Array<{ table: string; sourceTable: string; label: string; reason: string; rows: number }> };
    const by = new Map(json.targets.map((t) => [t.table, t]));
    expect(by.get("email_notifications_sent")).toMatchObject({ rows: 1, sourceTable: "email_notifications", label: "Delivered email queue rows" });
    expect(by.get("email_notifications_sent")!.reason).not.toMatch(/suppressed\. The delivery is done/);
    // a table name keys no line: each email line has its own key (N6 fix pass 2)
    expect(by.has("email_notifications")).toBe(false);
    const ab = by.get("email_notifications_suppressed")!;
    expect(ab).toMatchObject({ rows: 2, sourceTable: "email_notifications", label: "Abandoned email queue rows (never sent)" });
    expect(ab.reason).toMatch(/never delivered/);
    // most first; a tie in name order
    expect(ab.reason).toContain("These are: 1 comment_mention, 1 watcher_activity queued 2026-01-01 to 2026-01-05 (UTC).");
    // read notifications: only the plain read row — the three watermark rows and the unread one are kept
    expect(by.get("notifications")!.rows).toBe(1);
  });

  const purgeAll = (extra: Row = {}) => purgePOST(new NextRequest("http://x/api/admin/purge", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ orgId: "oA", days: 30, confirm: true, ...extra }) }));

  it("the purge deletes sent and abandoned rows (never failed or queued), keeps watermark rows, and records what was abandoned BEFORE deleting it", async () => {
    seedPurge();
    // what the audit log holds at the moment each email_notifications delete runs
    const atDelete: string[][] = [];
    db.onExec = (table, op) => { if (table === "email_notifications" && op === "delete") atDelete.push(rows("audit_logs").map((a) => String(a.action))); };
    const res = await purgeAll();
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("auditError");
    expect(rows("email_notifications").map((r) => r.id)).toEqual(["f1"]);
    expect(rows("notifications").map((r) => r.id).sort()).toEqual(["u1", "w1", "w2", "w3"]);
    // delivered first (nothing to record), then abandoned — after its record landed
    expect(atDelete).toEqual([[], ["DATA_PURGE_ABANDONED_EMAIL"]]);
    const record = rows("audit_logs").find((a) => a.action === "DATA_PURGE_ABANDONED_EMAIL")!;
    expect(record).toMatchObject({ org_id: "oA", user_id: "dc1", user_email: "dc1@x.io" });
    expect(record.details).toMatchObject({
      rows: 2, abandoned: { byEventType: { watcher_activity: 1, comment_mention: 1 }, oldest: old, newest: "2026-01-05T00:00:00.000Z" },
    });
    const audit = rows("audit_logs").find((a) => a.action === "DATA_PURGE")!;
    const deleted = (audit.details as { deleted: Array<{ table: string; rows: number; abandoned?: unknown }> }).deleted;
    expect(deleted.find((d) => d.table === "email_notifications_suppressed")).toMatchObject({
      rows: 2, abandoned: { byEventType: { watcher_activity: 1, comment_mention: 1 }, oldest: old, newest: "2026-01-05T00:00:00.000Z" },
    });
    expect(deleted.find((d) => d.table === "email_notifications_sent")).toMatchObject({ rows: 1 });
  });

  it("no record, no delete: a refused audit insert leaves the abandoned rows in place and says so; a refused DATA_PURGE row is reported, never a silent success", async () => {
    seedPurge();
    db.writeError.audit_logs = { message: "audit refused" };
    const res = await purgeAll();
    expect(res.status).toBe(200);
    const out = await res.json() as { deleted: Array<{ table: string; rows: number; error?: string }>; auditError?: string };
    // the abandoned mail is still there; delivered rows (disposable) went as before
    expect(rows("email_notifications").map((r) => r.id).sort()).toEqual(["f1", "x1", "x2"]);
    expect(out.deleted.find((d) => d.table === "email_notifications_suppressed")).toMatchObject({
      rows: 0, error: "not purged — the record of what it holds could not be written first: audit refused",
    });
    expect(out.auditError).toBe("the purge ran but its DATA_PURGE audit row was not written: audit refused");
  });

  it("the breakdown is exact past the API's row cap (max-rows 1000): 2,500 abandoned rows, kinds and dates from every one of them", async () => {
    db.maxRows = 1000;
    db.tables.email_notifications = [];
    // inserted newest-first: an unordered capped read would see only the first 1,000
    for (let i = 0; i < 1000; i++) db.tables.email_notifications.push({ id: `a${i}`, org_id: ORG_A, status: "suppressed", created_at: "2026-02-11T00:00:00.000Z", event_type: "watcher_activity" });
    for (let i = 0; i < 1200; i++) db.tables.email_notifications.push({ id: `b${i}`, org_id: ORG_A, status: "suppressed", created_at: "2026-01-20T00:00:00.000Z", event_type: "comment_mention" });
    for (let i = 0; i < 299; i++) db.tables.email_notifications.push({ id: `c${i}`, org_id: ORG_A, status: "suppressed", created_at: "2026-01-10T00:00:00.000Z", event_type: "assignment" });
    db.tables.email_notifications.push({ id: "d0", org_id: ORG_A, status: "suppressed", created_at: "2026-01-03T00:00:00.000Z", event_type: null });
    db.tables.email_notifications.push({ id: "z0", org_id: ORG_B, status: "suppressed", created_at: "2025-12-01T00:00:00.000Z", event_type: "sla_warning" });
    const res = await purgeGET(new NextRequest("http://x/api/admin/purge?orgId=oA&days=30", { headers: { authorization: "Bearer t" } }));
    const json = await res.json() as { targets: Array<{ table: string; reason: string; rows: number }> };
    const ab = json.targets.find((t) => t.table === "email_notifications_suppressed")!;
    expect(ab.rows).toBe(2500);
    expect(ab.reason).toContain("These are: 1200 comment_mention, 1000 watcher_activity, 299 assignment, 1 unknown queued 2026-01-03 to 2026-02-11 (UTC).");
    // no bulk read of the line: every read of it is a head count or one row
    const src0 = src("app/api/admin/purge/route.ts");
    expect(src0).not.toMatch(/\.select\("event_type, created_at"\)/);
  });

  it("MINOR (fix pass 2): each `tables` name selects one line — the delivered line's key never purges the abandoned mail; the bare table name (an older client's) selects the delivered line alone, and the plan says so", async () => {
    const purgeOnly = (tables: string[]) => purgePOST(new NextRequest("http://x/api/admin/purge", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ orgId: "oA", days: 30, confirm: true, tables }) }));
    seedPurge();
    await purgeOnly(["email_notifications_suppressed"]);
    expect(rows("email_notifications").map((r) => r.id).sort()).toEqual(["f1", "s1"]);
    // a client keying lines by the plan's `table` picks "Delivered email" alone
    seedPurge();
    db.tables.audit_logs = [];
    const res = await purgeOnly(["email_notifications_sent"]);
    expect(rows("email_notifications").map((r) => r.id).sort()).toEqual(["f1", "x1", "x2"]);
    expect(rows("audit_logs").some((a) => a.action === "DATA_PURGE_ABANDONED_EMAIL")).toBe(false);
    expect((await res.json() as { deleted: Array<{ table: string }> }).deleted.map((d) => d.table)).toEqual(["email_notifications_sent"]);
    // the bare table name no longer expands to the abandoned line
    seedPurge();
    await purgeOnly(["email_notifications"]);
    expect(rows("email_notifications").map((r) => r.id).sort()).toEqual(["f1", "x1", "x2"]);
    // a name that is no line selects nothing (never every target)
    seedPurge();
    await purgeOnly(["constructor"]);
    expect(rows("email_notifications")).toHaveLength(4);
    const plan = await (await purgeGET(new NextRequest("http://x/api/admin/purge?orgId=oA&days=30", { headers: { authorization: "Bearer t" } }))).json() as { legacyTableNames: Record<string, string> };
    expect(plan.legacyTableNames).toEqual({ email_notifications: "email_notifications_sent" });
  });

  it("the kept watermark lists are 20261160's — the NEWEST definition of enforce_notification_insert() in the sequence (scanned at test time)", () => {
    const dir = join(ROOT, "supabase", "migrations");
    const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
    const definers = files.filter((f) => readFileSync(join(dir, f), "utf8").replace(/--[^\n]*/g, "").includes("CREATE OR REPLACE FUNCTION enforce_notification_insert()"));
    const newest = readFileSync(join(dir, definers[definers.length - 1]), "utf8");
    const listed = (re: RegExp) => [...newest.match(re)![1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
    const kinds = listed(/IF NEW\.kind IN \(([^)]*)\) THEN/);
    const keys = listed(/IF NEW\.metadata \?\| ARRAY\[([^\]]*)\] THEN/);
    const route = src("app/api/admin/purge/route.ts");
    const arr = (name: string) => [...route.match(new RegExp(`const ${name} = \\[([^\\]]*)\\];`))![1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect(arr("PURGE_KEEPS_WATERMARK_KEYS").sort()).toEqual([...keys].sort());
    expect(arr("PURGE_KEEPS_KINDS").sort()).toEqual([...kinds].sort());
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("20261183 — DELIV-1 dw3: who queued an email, in the DEC-30 one-paste shape", () => {
  const FILE = "20261183_notif_roundG_email_attribution.sql";
  const dir = join(ROOT, "supabase", "migrations");
  const M = readFileSync(join(dir, FILE), "utf8");
  const code = M.replace(/--[^\n]*/g, "");

  it("is numbered in the sequence, named for its package, and one script: TEMP inventory → BEGIN … COMMIT → one final SELECT (check, ok, n)", () => {
    expect(readdirSync(dir)).toContain(FILE);
    const iTemp = code.indexOf("CREATE TEMP TABLE notif_round_g_183_before");
    const iBegin = code.indexOf("BEGIN;");
    const iCommit = code.indexOf("COMMIT;");
    expect(iTemp).toBeGreaterThan(0);
    expect(iTemp).toBeLessThan(iBegin);
    expect(iBegin).toBeLessThan(iCommit);
    expect((code.match(/\bBEGIN;/g) ?? []).length).toBe(1);
    expect((code.match(/\bCOMMIT;/g) ?? []).length).toBe(1);
    const tail = code.slice(iCommit);
    expect((tail.match(/^SELECT /gm) ?? []).length).toBe(1 + (tail.match(/^UNION ALL\nSELECT /gm) ?? []).length);
    expect(tail).toMatch(/^SELECT 'email_notifications\.queued_by is a nullable uuid' AS check,\n[\s\S]*AS ok,\n\s+NULL::text AS n/m);
    expect(tail.trim().endsWith("SELECT inventory, NULL::boolean, n FROM notif_round_g_183_before;")).toBe(true);
    // the inventory is counts only — never a customer row
    const inv = code.slice(iTemp, iBegin);
    expect(inv).not.toMatch(/SELECT \*|subject|body_text|to_email/);
    expect((inv.match(/COUNT\(\*\)/g) ?? []).length).toBe(3);
  });

  it("adds the column, a SECURITY INVOKER trigger function with search_path pinned and EXECUTE revoked, and the BEFORE INSERT trigger — nothing else re-created", () => {
    expect(code).toContain("ALTER TABLE email_notifications ADD COLUMN IF NOT EXISTS queued_by UUID;");
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION stamp_email_queued_by\(\)\nRETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS \$\$/);
    expect(code).not.toMatch(/SECURITY DEFINER/);
    expect(code).toMatch(/IF auth\.uid\(\) IS NOT NULL THEN\n\s+NEW\.queued_by := auth\.uid\(\);\n\s+END IF;/);
    expect(code).toContain("REVOKE ALL ON FUNCTION stamp_email_queued_by() FROM PUBLIC, anon, authenticated;");
    expect(code).toMatch(/DROP TRIGGER IF EXISTS trg_email_queued_by ON email_notifications;\nCREATE TRIGGER trg_email_queued_by\nBEFORE INSERT ON email_notifications\nFOR EACH ROW EXECUTE FUNCTION stamp_email_queued_by\(\);/);
    const created = [...code.matchAll(/CREATE (?:OR REPLACE )?(FUNCTION|TRIGGER|POLICY) (\w+)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(created).toEqual(["FUNCTION stamp_email_queued_by", "TRIGGER trg_email_queued_by"]);
    expect(code).not.toMatch(/CREATE (OR REPLACE )?FUNCTION enforce_email_requeue_columns/);
    expect(code).not.toMatch(/(CREATE|DROP|ALTER) POLICY/);
  });

  it("queued_by is immutable to a signed-in updater WITHOUT re-creating the requeue trigger: its NEWEST definition (scanned) compares the whole row", () => {
    const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
    const definers = files.filter((f) => readFileSync(join(dir, f), "utf8").replace(/--[^\n]*/g, "").includes("CREATE OR REPLACE FUNCTION enforce_email_requeue_columns()"));
    expect(definers.length).toBeGreaterThan(0);
    const newest = readFileSync(join(dir, definers[definers.length - 1]), "utf8");
    expect(newest).toContain("IF (to_jsonb(NEW) - 'status' - 'attempt_count' - 'updated_at')\n     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'attempt_count' - 'updated_at') THEN");
    // and the paste probes the live body for exactly that comparison
    expect(code).toContain("p.prosrc LIKE '%(to_jsonb(NEW) - ''status'' - ''attempt_count'' - ''updated_at'')%IS DISTINCT FROM (to_jsonb(OLD) - ''status'' - ''attempt_count'' - ''updated_at'')%'");
  });

  it("the app never reads or writes queued_by (works before and after the paste); the schema health card names the file", () => {
    for (const f of ["lib/notifications.ts", "lib/notify/dispatch.ts", "app/api/cron/maintenance/route.ts", "app/api/tickets/comment/route.ts", "app/api/tickets/workflow-action/route.ts", "app/api/notifications/send-queued/route.ts"]) {
      expect(src(f), f).not.toContain("queued_by");
    }
    expect(src("lib/schemaExpectations.ts")).toContain('{ table: "email_notifications", column: "queued_by", migration: "20261183_notif_roundG_email_attribution.sql"');
  });
});
