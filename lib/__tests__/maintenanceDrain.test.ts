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
//              and the footer to member mail; the unsubscribe route works.
//   DELIV-8    the purge lists abandoned (suppressed) mail as its own line and
//              records it; read rows carrying a dedupe watermark are kept.
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
    const matching = () => (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const exec = (): { data: unknown; error: unknown; count?: number } => {
      db.calls.push({ table, op: `exec:${op}`, args: [] });
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
          if (hit) Object.assign(hit, r); else db.tables[table] = [...(db.tables[table] ?? []), { ...r }];
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
            case "upsert": op = "upsert"; payload = args[0]; onConflict = (args[1] as { onConflict?: string } | undefined)?.onConflict ?? null; break;
            case "eq": filters.push((r) => at(r, String(args[0])) === args[1]); break;
            case "neq": filters.push((r) => at(r, String(args[0])) !== args[1]); break;
            case "in": { const s = new Set(args[1] as unknown[]); filters.push((r) => s.has(at(r, String(args[0])))); break; }
            case "is": filters.push((r) => (args[1] === null ? at(r, String(args[0])) == null : at(r, String(args[0])) === args[1])); break;
            case "gt": filters.push((r) => String(at(r, String(args[0]))) > String(args[1])); break;
            case "gte": filters.push((r) => String(at(r, String(args[0]))) >= String(args[1])); break;
            case "lt": filters.push((r) => String(at(r, String(args[0]))) < String(args[1])); break;
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
    rpc: async (fn: string) => ({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } }),
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
vi.mock("@/lib/intakeRateLimit", () => ({
  flushFoldedIntakeNotices: async () => ({ digests: 0, failed: 0, unrecorded: 0 }),
  deliverFoldedDigest: async () => 0, foldedDigestKind: () => "doc_superseded", foldedDigestMetadata: () => ({}),
  nudgeReviewHealth: async () => ({ nudged: 0, failed: 0, orgless: 0 }), REVIEW_HEALTH_KIND: "review_overdue",
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
const savedFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  db.tables = { orgs: [{ id: ORG_A, name: "Org A" }, { id: ORG_B, name: "Org B" }] };
  db.calls = []; db.readError = {}; db.writeError = {}; db.seq = 0;
  drainAnswers = []; drainCalls = 0; resendBodies = []; resendStatus = [];
  for (const k of ["NEXT_PUBLIC_SITE_URL", "VERCEL_PROJECT_PRODUCTION_URL", "NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL", "RESEND_API_KEY", "EMAIL_UNSUBSCRIBE_SECRET"]) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  process.env.NEXT_PUBLIC_SITE_URL = ORIGIN;
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/api/notifications/send-queued")) {
      drainCalls += 1;
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
    // the read is scoped: every notifications read carries the recipient's org and uid
    const reads = db.calls.filter((c) => c.table === "notifications" && c.op === "select");
    expect(reads.length).toBeGreaterThanOrEqual(6);
    const scoped = db.calls.filter((c) => c.table === "notifications" && c.op === "eq" && (c.args[0] === "user_id" || c.args[0] === "org_id"));
    expect(scoped.length).toBeGreaterThanOrEqual(2 * 6);
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
    expect(r.errors.filter((e) => /compliance-digest: oA\/.*: the digest was not queued: permission denied/.test(e))).toHaveLength(3);
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
    expect(String(d.body_text)).toMatch(/from the 25 hours to \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00 \(UTC\)\./);
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

  it("member mail carries List-Unsubscribe (signed for to_user_id) + List-Unsubscribe-Post; an unrendered row gets the footer at send; a rendered one is sent as stored; external mail gets neither", async () => {
    process.env.RESEND_API_KEY = "re_test";
    db.tables.email_notifications = [
      queued({ id: "e1", to_user_id: U(1), to_email: "a@x.io", body_text: `ping @[Mike](${U(5)})`, metadata: null }),
      queued({ id: "e2", to_user_id: U(2), to_email: "b@x.io", body_text: "rendered text", body_html: "<p>rendered</p>", metadata: { rendered: true } }),
      queued({ id: "e3", to_user_id: U(3), to_email: "contractor@ext.io", body_text: "portal", body_html: "<p>portal</p>", metadata: { external: true } }),
    ];
    const res = await drain();
    expect(await res.json()).toEqual({ processed: 3, sent: 3, failed: 0 });
    const byTo = new Map(resendBodies.map((b) => [b.to as string, b]));
    const a = byTo.get("a@x.io")!;
    const tokenA = signUnsubscribe(U(1))!;
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

  it("GET shows the choice and changes nothing (mail scanners fetch GET); a bad link is refused", async () => {
    const t = signUnsubscribe(U(1))!;
    const res = await unsubGET(new NextRequest(url(U(1), t)));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<form method="post"');
    expect(html).toContain("Drawing recalls and safety alerts are still emailed");
    expect(rows("notification_preferences")).toEqual([]);
    expect((await unsubGET(new NextRequest(url(U(1), "forged")))).status).toBe(400);
  });

  it("the one-click POST turns email off for THAT member only (an upsert — a member with no row gets one, every other column at its default)", async () => {
    db.tables.notification_preferences = [{ user_id: U(2), email_enabled: true, digest_frequency: "instant" }];
    const res = await unsubPOST(new NextRequest(url(U(1), signUnsubscribe(U(1))!), { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } }));
    expect(await res.json()).toEqual({ ok: true });
    expect(rows("notification_preferences").find((p) => p.user_id === U(1))).toMatchObject({ email_enabled: false });
    expect(rows("notification_preferences").find((p) => p.user_id === U(2))).toMatchObject({ email_enabled: true });
    const up = db.calls.find((c) => c.table === "notification_preferences" && c.op === "upsert")!;
    expect(Object.keys(up.args[0] as Row).sort()).toEqual(["email_enabled", "updated_at", "user_id"]);
    expect(up.args[1]).toEqual({ onConflict: "user_id" });
  });

  it("another member's token, or none, writes nothing; a refused write is a 500, never a fake success", async () => {
    const res = await unsubPOST(new NextRequest(url(U(1), signUnsubscribe(U(2))!), { method: "POST" }));
    expect(res.status).toBe(400);
    expect(rows("notification_preferences")).toEqual([]);
    db.writeError.notification_preferences = { message: "denied" };
    const res2 = await unsubPOST(new NextRequest(url(U(1), signUnsubscribe(U(1))!), { method: "POST", headers: { accept: "text/html" } }));
    expect(res2.status).toBe(500);
    expect(await res2.text()).toContain("could not be saved");
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
    expect(by.get("email_notifications")).toMatchObject({ rows: 1, sourceTable: "email_notifications", label: "Delivered email queue rows" });
    expect(by.get("email_notifications")!.reason).not.toMatch(/suppressed\. The delivery is done/);
    const ab = by.get("email_notifications_suppressed")!;
    expect(ab).toMatchObject({ rows: 2, sourceTable: "email_notifications", label: "Abandoned email queue rows (never sent)" });
    expect(ab.reason).toMatch(/never delivered/);
    expect(ab.reason).toContain("These are: 1 watcher_activity, 1 comment_mention queued 2026-01-01 to 2026-01-05 (UTC).");
    // read notifications: only the plain read row — the three watermark rows and the unread one are kept
    expect(by.get("notifications")!.rows).toBe(1);
  });

  it("the purge deletes sent and abandoned rows (never failed or queued), keeps watermark rows, and its DATA_PURGE row records what was abandoned", async () => {
    seedPurge();
    const res = await purgePOST(new NextRequest("http://x/api/admin/purge", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ orgId: "oA", days: 30, confirm: true }) }));
    expect(res.status).toBe(200);
    expect(rows("email_notifications").map((r) => r.id)).toEqual(["f1"]);
    expect(rows("notifications").map((r) => r.id).sort()).toEqual(["u1", "w1", "w2", "w3"]);
    const audit = rows("audit_logs").find((a) => a.action === "DATA_PURGE")!;
    const deleted = (audit.details as { deleted: Array<{ table: string; rows: number; abandoned?: unknown }> }).deleted;
    expect(deleted.find((d) => d.table === "email_notifications_suppressed")).toMatchObject({
      rows: 2, abandoned: { byEventType: { watcher_activity: 1, comment_mention: 1 }, oldest: old, newest: "2026-01-05T00:00:00.000Z" },
    });
    expect(deleted.find((d) => d.table === "email_notifications")).toMatchObject({ rows: 1 });
  });

  it("REGRESSION: a `tables` subset naming the table still purges both of its lines (as 'sent or suppressed' did); naming a line purges that line alone", async () => {
    seedPurge();
    await purgePOST(new NextRequest("http://x/api/admin/purge", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ orgId: "oA", days: 30, confirm: true, tables: ["email_notifications_suppressed"] }) }));
    expect(rows("email_notifications").map((r) => r.id).sort()).toEqual(["f1", "s1"]);
    seedPurge();
    await purgePOST(new NextRequest("http://x/api/admin/purge", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ orgId: "oA", days: 30, confirm: true, tables: ["email_notifications"] }) }));
    expect(rows("email_notifications").map((r) => r.id)).toEqual(["f1"]);
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
