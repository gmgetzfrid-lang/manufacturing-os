// notifications Round G — N19 NOTICE RECORD REMAINDERS, DELIV-18 (the daily
// compliance digest; drafting-flow EVID-9 done-when 2), driven through the
// REAL maintenance cron over the maintenanceDrain in-memory PostgREST
// stand-in (filters, ordering and limits applied).
//
//   * a member whose OWN preferences turn the digest off (the master switch
//     or delivery "never" — the app's one rule, emailAllowedByPrefs) and who
//     a visit reaches (active, with an address, holding unread compliance
//     notices in the window) gets ONE not_emailed record a day — written
//     after every digest is queued and the state recorded, and (the N19 fix
//     pass) only after the cron's 6c drain has sent them; a re-run the same
//     day records nobody twice;
//   * the record is bookkeeping, bounded: a record read or insert that never
//     answers delays no send and no later step (each is abandoned after its
//     limit), and a run with no time left — before the record step, or after
//     its first chunk — stops recording and says so;
//   * (the N19 merge-time fix) the record step runs after the prunes 7b, 7c
//     and 7d: with time short and the record hanging they still run, with
//     their time; with ample time it records as before;
//   * the last-digest read ignores a not_emailed record: a record is never
//     read as the digest sent (it would silence today's digest or start the
//     next list after items never sent);
//   * REGRESSION, pinned before and after 20261258: who is digested and every
//     digest row are byte-identical; before the paste the refused record is
//     said once and changes nothing else (no error line, the state as before).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { resetDeliveryRecordLatches, notEmailedRecordLatch } from "@/lib/deliveryRecordLatch";

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
    /** A column a migration adds, not yet pasted: a filter naming it answers
     *  42703, as PostgREST does (NEDGE-20, N14: email_notifications.queued_by). */
    missingColumn: {} as Record<string, string>,
    /** before 20261258: the status CHECK refuses a not_emailed row (23514). */
    refuseNotEmailed: false as boolean | { code: string; message: string },
    /** The record's calls that never answer ("read": today's records;
     *  "insert": the record) — they settle only when their abort signal fires. */
    hang: new Set<string>(),
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
    let recordRead = false;
    let signal: AbortSignal | null = null;
    const named: string[] = [];
    const matching = () => (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const exec = (): { data: unknown; error: unknown; count?: number } => {
      db.calls.push({ table, op: `exec:${op}`, args: [] });
      db.onExec?.(table, op);
      if (op === "select") {
        const gone = db.missingColumn[table];
        if (gone && named.includes(gone)) return { data: null, error: { code: "42703", message: `column ${table}.${gone} does not exist` } };
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
      if (op === "insert" && db.refuseNotEmailed && ((Array.isArray(payload) ? payload : [payload]) as Row[]).some((r) => r.status === "not_emailed")) {
        return { data: null, error: db.refuseNotEmailed === true ? { code: "23514", message: 'new row for relation "email_notifications" violates check constraint "email_notifications_status_check"' } : db.refuseNotEmailed };
      }
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
        if (prop === "then") return (res: (v: unknown) => void, rej?: (e: unknown) => void) => {
          const kind = op === "insert" && ((Array.isArray(payload) ? payload : [payload]) as Row[]).some((r) => r?.status === "not_emailed") ? "insert"
            : op === "select" && recordRead ? "read" : null;
          if (kind && db.hang.has(kind)) {
            db.calls.push({ table, op: `hang:${kind}`, args: [] });
            return new Promise((resolve) => {
              const done = () => { db.calls.push({ table, op: `aborted:${kind}`, args: [] }); resolve({ data: null, error: { message: "AbortError: This operation was aborted" } }); };
              if (signal?.aborted) done(); else signal?.addEventListener("abort", done);
            }).then(res, rej);
          }
          return Promise.resolve(exec()).then(res, rej);
        };
        return (...args: unknown[]) => {
          db.calls.push({ table, op: prop, args });
          switch (prop) {
            case "select": if (op === "select") head = !!(args[1] as { head?: boolean } | undefined)?.head; break;
            case "insert": case "update": case "delete": op = prop; payload = args[0]; break;
            case "upsert": op = "upsert"; payload = args[0]; onConflict = (args[1] as { onConflict?: string } | undefined)?.onConflict ?? null; ignoreDuplicates = !!(args[1] as { ignoreDuplicates?: boolean } | undefined)?.ignoreDuplicates; break;
            case "eq": if (args[0] === "status" && args[1] === "not_emailed") recordRead = true; filters.push((r) => at(r, String(args[0])) === args[1]); break;
            case "abortSignal": signal = args[0] as AbortSignal; break;
            case "neq": filters.push((r) => at(r, String(args[0])) !== args[1]); break;
            case "in": { const s = new Set(args[1] as unknown[]); filters.push((r) => s.has(at(r, String(args[0])))); break; }
            case "is": named.push(String(args[0])); filters.push((r) => (args[1] === null ? at(r, String(args[0])) == null : at(r, String(args[0])) === args[1])); break;
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
vi.mock("@/lib/reviewCycles", () => ({ scanAndNotifyReviews: vi.fn(async () => 0) }));
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
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => ({ recipients: 0 })), PUSH_OPT_IN_SINCE: "2026-10-14T00:00:00.000Z" }));
vi.mock("@/lib/serverAuth", () => ({
  authorizeOrgRole: vi.fn(async () => ({ userId: "dc1", email: "dc1@x.io", orgId: "oA", role: "DocCtrl", roles: ["DocCtrl"], admin: makeClient() })),
}));

import { GET as cronGET } from "@/app/api/cron/maintenance/route";
import { emit } from "@/lib/notify/dispatch";

const ORIGIN = "https://ops.example.com";
const ORG_A = "oA", ORG_B = "oB";
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const runCron = async () => {
  const res = await cronGET(new NextRequest("http://cron.local/api/cron/maintenance", { headers: { authorization: "Bearer cron-secret" } }));
  expect(res.status).toBe(200);
  return res.json() as Promise<Record<string, unknown> & { errors: string[] }>;
};
const rows = (t: string) => db.tables[t] ?? [];
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** Queue the drain's answers, one per send-queued call, in order (then: empty). */
let drainAnswers: Array<{ status?: number; body?: unknown }> = [];
let resendBodies: Array<Record<string, unknown>> = [];
let resendStatus: number[] = [];
/** How long each send-queued batch "takes" on the faked clock (0: no time). */
let drainTakesMs = 0;
/** How many of the next send-queued batches never answer (settle only on abort). */
let drainHangs = 0;
/** Called on every send-queued call (the drain's batches), after it is logged in db.calls. */
let onDrain: null | ((n: number) => void) = null;
let drainCalls = 0;
const savedFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  db.tables = { orgs: [{ id: ORG_A, name: "Org A" }, { id: ORG_B, name: "Org B" }] };
  db.calls = []; db.readError = {}; db.writeError = {}; db.seq = 0; db.maxRows = null; db.onExec = null; db.rpcs = {}; db.folded = []; db.missingColumn = {}; db.refuseNotEmailed = false;
  resetDeliveryRecordLatches();
  drainAnswers = []; resendBodies = []; resendStatus = []; drainTakesMs = 0; drainHangs = 0; onDrain = null; drainCalls = 0; db.hang = new Set();
  vi.mocked(emit).mockReset();
  vi.mocked(emit).mockImplementation(async () => ({ recipients: 0 }));
  for (const k of ["NEXT_PUBLIC_SITE_URL", "VERCEL_PROJECT_PRODUCTION_URL", "NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL", "RESEND_API_KEY", "EMAIL_UNSUBSCRIBE_SECRET"]) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  process.env.NEXT_PUBLIC_SITE_URL = ORIGIN;
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/api/notifications/send-queued")) {
      db.calls.push({ table: "fetch", op: "send-queued", args: [] });
      onDrain?.(++drainCalls);
      if (drainHangs > 0) {
        drainHangs -= 1;
        const sig = init?.signal;
        return new Promise<Response>((_res, rej) => {
          if (sig?.aborted) rej(sig.reason);
          sig?.addEventListener("abort", () => rej(sig.reason));
        });
      }
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
  vi.useRealTimers();
  globalThis.fetch = savedFetch;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  vi.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
const member = (org: string, uid: string, status = "active", email: string | null = `${uid.slice(-4)}@${org}.io`) =>
  ({ org_id: org, uid, status, email, role: "Engineer", roles: null });
const notice = (org: string, uid: string, kind: string, title: string, created: string, over: Row = {}) =>
  ({ id: `00000000-0000-4000-a000-${String(++db.seq).padStart(12, "0")}`, org_id: org, user_id: uid, kind, title, link: "/documents/l?doc=d", created_at: created, read_at: null, metadata: null, ...over });
const allDigestRows = () => rows("email_notifications").filter((e) => e.event_type === "compliance_digest");
const sent = () => allDigestRows().filter((e) => e.status === "queued");
const records = () => allDigestRows().filter((e) => e.status === "not_emailed");
const today = () => new Date().toISOString().slice(0, 10);
const strip = (r: Row) => { const { id: _i, created_at: _c, ...rest } = r; const m = { ...(rest.metadata as Row) }; delete m.since; delete m.through; delete m.tail; return { ...rest, metadata: m, body_text: String(rest.body_text).replace(/from .* to .*\./, "WINDOW."), body_html: String(rest.body_html ?? "").replace(/from .* to .*\./, "WINDOW.") }; };

const seed = () => {
  db.tables.org_members = [
    member(ORG_A, U(1)),                    // opted in
    member(ORG_A, U(2)),                    // master switch off
    member(ORG_A, U(3)),                    // delivery "never"
    member(ORG_A, U(4), "active", null),    // opted out, no address on record
    member(ORG_A, U(5), "suspended"),       // opted out, not an active member
    member(ORG_B, U(2)),                    // the same person in another org
  ];
  db.tables.notifications = [
    notice(ORG_A, U(1), "review_due", "Due 1", minutesAgo(10)),
    notice(ORG_A, U(2), "review_due", "Due 2", minutesAgo(10)),
    notice(ORG_A, U(3), "ack_requested", "Ack 3", minutesAgo(10)),
    notice(ORG_A, U(4), "review_due", "Due 4", minutesAgo(10)),
    notice(ORG_A, U(5), "review_due", "Due 5", minutesAgo(10)),
    notice(ORG_B, U(2), "review_due", "Due 2 in B", minutesAgo(10)),
  ];
  db.tables.notification_preferences = [
    { user_id: U(2), email_enabled: false },
    { user_id: U(3), digest_frequency: "never" },
    { user_id: U(4), email_enabled: false },
    { user_id: U(5), email_enabled: false },
  ];
};

describe("DELIV-18 — the compliance digest records the members their own preferences left out", () => {
  it("REGRESSION: the digest goes to exactly the opted-in member, as before; each opted-out member a visit reached gets ONE record per org — nobody with no address, nobody inactive", async () => {
    seed();
    const r = await runCron();
    expect(r.complianceEmails).toBe(1);
    expect(sent().map((e) => e.to_user_id)).toEqual([U(1)]);
    expect(records().map((e) => `${e.org_id}/${e.to_user_id}`).sort()).toEqual([`${ORG_A}/${U(2)}`, `${ORG_A}/${U(3)}`, `${ORG_B}/${U(2)}`].sort());
    expect(r.errors.filter((e) => e.startsWith("compliance-digest:"))).toEqual([]);
  });

  it("the record: status not_emailed (never drained), the person and address, event compliance_digest, no resource, the cause named as their preference, today's day and the visit's window", async () => {
    seed();
    await runCron();
    const rec = records().find((e) => e.org_id === ORG_A && e.to_user_id === U(2))!;
    expect(rec).toMatchObject({
      to_email: `${U(2).slice(-4)}@${ORG_A}.io`, subject: "Compliance items need you", body_html: null,
      resource_type: null, resource_id: null, event_type: "compliance_digest", status: "not_emailed",
    });
    const meta = rec.metadata as Row & { window: { from: string; to: string } };
    expect(meta.not_emailed).toEqual({ byTheirChoice: true, reason: "preference" });
    expect(meta.day).toBe(today());
    expect(Date.parse(meta.window.from)).toBeLessThan(Date.parse(meta.window.to));
    expect(meta).not.toHaveProperty("through");  // never mistakable for a sent digest's window end
    expect(String(rec.body_text)).toMatch(/^Today's compliance digest \(\d{4}-\d{2}-\d{2}\) was not emailed: this member's email preferences turn it off\./);
    expect(String(rec.body_text)).not.toContain("Due 2");   // nothing of what it would have listed
  });

  it("written last: after every digest is queued, after the state is recorded, and after the 6c drain that sends this run's digests — no send and no state waits on it", async () => {
    seed();
    await runCron();
    const writes = db.calls.filter((c) => (c.table === "email_notifications" && c.op === "insert") || (c.table === "platform_settings" && c.op === "upsert") || c.table === "fetch");
    const kinds = writes.map((c) => c.table === "fetch" ? "drain" : c.table === "platform_settings" ? "state" : ((Array.isArray(c.args[0]) ? c.args[0] : [c.args[0]]) as Row[])[0].status);
    const firstRecord = kinds.indexOf("not_emailed");
    expect(firstRecord).toBeGreaterThan(kinds.lastIndexOf("queued"));
    expect(firstRecord).toBeGreaterThan(kinds.lastIndexOf("state"));
    // the 6c drain (the batch after the digest's rows are queued) ran before any record was asked —
    // neither today's records read nor the insert
    const drainAfterDigest = kinds.indexOf("drain", kinds.lastIndexOf("queued"));
    expect(drainAfterDigest).toBeGreaterThan(-1);
    expect(firstRecord).toBeGreaterThan(drainAfterDigest);
    const allIdx = (pred: (c: { table: string; op: string; args: unknown[] }) => boolean) => db.calls.findIndex(pred);
    const lastDrain = db.calls.map((c) => c.table).lastIndexOf("fetch");
    expect(allIdx((c) => c.table === "email_notifications" && c.op === "eq" && c.args[0] === "status" && c.args[1] === "not_emailed")).toBeGreaterThan(lastDrain);
  });

  it("a re-run the same day records nobody twice and mails nobody twice", async () => {
    seed();
    await runCron();
    const [s1, r1] = [sent().length, records().length];
    await runCron();
    expect(sent().length).toBe(s1);
    expect(records().length).toBe(r1);
  });

  it("the last-digest read ignores a not_emailed record: a member who turned email back on gets today's digest, from their window, even with a record dated today", async () => {
    seed();
    db.tables.notification_preferences = [];      // everyone opted in now
    db.tables.email_notifications = [{
      id: "rec", org_id: ORG_A, to_user_id: U(2), event_type: "compliance_digest", status: "not_emailed", created_at: minutesAgo(30),
      metadata: { day: today(), window: { from: minutesAgo(60 * 25), to: minutesAgo(30) }, not_emailed: { byTheirChoice: true, reason: "preference" } },
    }];
    await runCron();
    const d = sent().find((e) => e.org_id === ORG_A && e.to_user_id === U(2))!;
    expect(d).toBeTruthy();
    expect(String(d.body_text)).toContain("Due 2");
    const route = readFileSync(join(process.cwd(), "app/api/cron/maintenance/route.ts"), "utf8");
    expect(route).toMatch(/\.eq\("event_type", "compliance_digest"\)\n(?:\s*\/\/[^\n]*\n)*\s*\.neq\("status", "not_emailed"\);/);
  });

  it("REGRESSION, before 20261258: every digest row is byte-identical to the after-paste run; the refused record is said once, adds no error line, and later runs in the process ask nothing", async () => {
    seed();
    await runCron();
    const afterPaste = sent().map(strip);
    const stateAfter = (rows("platform_settings")[0].value as Row).orgs;
    db.tables.email_notifications = []; db.tables.platform_settings = []; db.calls = [];
    resetDeliveryRecordLatches();
    db.refuseNotEmailed = true;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const r = await runCron();
    expect(sent().map(strip)).toEqual(afterPaste);
    expect(records()).toEqual([]);
    expect(r.errors.filter((e) => e.startsWith("compliance-digest:"))).toEqual([]);
    expect(Object.keys((rows("platform_settings")[0].value as Row).orgs as Row)).toEqual(Object.keys(stateAfter as Row));
    expect(notEmailedRecordLatch.held()).toBe(true);
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/needs migration 20261258/));
    // a later run in the same process: no record read, no record insert
    db.tables.email_notifications = []; db.tables.platform_settings = []; db.calls = [];
    await runCron();
    const recordCalls = db.calls.filter((c) => c.table === "email_notifications" && c.op === "eq" && c.args[0] === "status" && c.args[1] === "not_emailed");
    expect(recordCalls).toEqual([]);
    expect(sent().map((e) => e.to_user_id)).toEqual([U(1)]);
  });

  it("a record read that fails records anyway (a fact twice is better than one lost) and says so; the digest is sent as before", async () => {
    seed();
    db.readError.email_notifications = { message: "read timeout" };
    const r = await runCron();
    expect(sent().map((e) => e.to_user_id)).toEqual([U(1)]);   // the last-digest read failing sends anyway, as before
    expect(records().length).toBe(3);
    expect(r.errors.some((e) => /compliance-digest: today's "not emailed by their choice" records could not be read — 3 member\(s\) recorded anyway/.test(e))).toBe(true);
  });

  it("a record insert refused for another reason is a line; the digests and the state are untouched", async () => {
    seed();
    db.refuseNotEmailed = { code: "42501", message: "permission denied" };
    const r = await runCron();
    expect(sent().map((e) => e.to_user_id)).toEqual([U(1)]);
    expect(records()).toEqual([]);
    expect(notEmailedRecordLatch.held()).toBe(false);
    expect(r.errors.some((e) => /compliance-digest: the record that 3 member\(s\) were not emailed today's digest by their own choice was not written: 42501: permission denied/.test(e))).toBe(true);
    expect(rows("platform_settings").length).toBe(1);
  });

  // Last but two: the abandoned insert spends the recorder's once-per-process line, which the
  // before-20261258 case above reads.
  it("a record read or insert that never answers delays no send: the 6c drain has sent this run's digests before either is asked; each is abandoned after its limit (aborted), said, and the run's later steps still run", async () => {
    seed();
    db.hang = new Set(["read", "insert"]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = runCron();
    await vi.waitFor(() => expect(db.calls.some((c) => c.op === "hang:read")).toBe(true));
    // the run is now waiting on the record's read: the digest is queued and the 6c drain already asked to send it
    const firstHang = db.calls.findIndex((c) => c.op === "hang:read");
    const lastQueued = db.calls.map((c, i) => (c.table === "email_notifications" && c.op === "insert" ? i : -1)).filter((i) => i >= 0).pop()!;
    expect(sent().map((e) => e.to_user_id)).toEqual([U(1)]);
    expect(db.calls.findIndex((c, i) => i > lastQueued && c.table === "fetch")).toBeGreaterThan(lastQueued);
    expect(db.calls.findIndex((c, i) => i > lastQueued && c.table === "fetch")).toBeLessThan(firstHang);
    expect(db.calls.slice(firstHang).some((c) => c.table === "fetch")).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);           // the read's limit
    await vi.waitFor(() => expect(db.calls.some((c) => c.op === "hang:insert")).toBe(true));
    await vi.advanceTimersByTimeAsync(5_000);           // the insert's limit
    const r = await p;
    expect(db.calls.some((c) => c.op === "aborted:read")).toBe(true);
    expect(db.calls.some((c) => c.op === "aborted:insert")).toBe(true);
    expect(records()).toEqual([]);
    expect(sent().map((e) => e.to_user_id)).toEqual([U(1)]);
    expect(r.errors).toContain(`compliance-digest: today's "not emailed by their choice" records could not be read — 3 member(s) recorded anyway (a re-run today may record them twice): no answer within 5 s — the request was abandoned`);
    expect(r.errors).toContain("compliance-digest: the record that 3 member(s) were not emailed today's digest by their own choice was not written: timeout: no answer within 5 s — the request was abandoned (it may still land)");
    expect(r.folderTrashPurged).toBe(0);                // the prunes ran (before it — the merge-time fix)
  });

  // N19 merge-time fix (the final review's minor 1): step 6d runs after the prunes 7b, 7c and 7d,
  // so it never spends the time AFTER_DIGEST_RESERVE_MS holds back for them.
  const recordReadAt = () => db.calls.findIndex((c) => c.table === "email_notifications" && c.op === "eq" && c.args[0] === "status" && c.args[1] === "not_emailed");
  const pruneCalls = () => ({
    trash: db.calls.findIndex((c) => c.table === "collections" && c.op === "delete"),
    push: db.calls.findIndex((c) => c.table === "push_subscriptions" && c.op.startsWith("exec:")),
    outbox: db.calls.findIndex((c) => c.table === "audit_dead_letters" && c.op.startsWith("exec:")),
  });

  it("time short and the record step hanging: 7b, 7c and 7d still run — before it, with their time — and the record's abandoned calls are said", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const T0 = Date.now();
    vi.setSystemTime(T0);
    seed();
    db.hang = new Set(["read", "insert"]);
    // the 6c drain's batch (the second send-queued call) returns 10 s before the run's end (300 s less 10 s):
    // a record step run first would spend all of it (a 5 s read, then a 5 s insert) and 7c / 7d would not run
    onDrain = (n) => { if (n === 2) vi.setSystemTime(T0 + 280_000); };
    const p = runCron();
    await vi.waitFor(() => expect(db.calls.some((c) => c.op === "hang:read")).toBe(true));
    const firstHang = db.calls.findIndex((c) => c.op === "hang:read");
    const prunes = pruneCalls();
    expect(prunes.trash).toBeGreaterThan(-1);
    expect(prunes.push).toBeGreaterThan(-1);
    expect(prunes.outbox).toBeGreaterThan(-1);
    expect(Math.max(prunes.trash, prunes.push, prunes.outbox)).toBeLessThan(firstHang);
    await vi.advanceTimersByTimeAsync(5_000);           // the read's limit
    await vi.waitFor(() => expect(db.calls.some((c) => c.op === "hang:insert")).toBe(true));
    await vi.advanceTimersByTimeAsync(5_000);           // the insert's limit
    const r = await p;
    expect(r.folderTrashPurged).toBe(0);
    expect(r.pushSubscriptionsPruned).toBe(0);
    expect(r.auditOutbox).toBeDefined();
    expect(r.errors.filter((e) => /^(push-subscriptions|audit-outbox): not run/.test(e))).toEqual([]);
    expect(sent().map((e) => e.to_user_id)).toEqual([U(1)]);
    expect(records()).toEqual([]);
    expect(r.errors).toContain(`compliance-digest: today's "not emailed by their choice" records could not be read — 3 member(s) recorded anyway (a re-run today may record them twice): no answer within 5 s — the request was abandoned`);
    expect(r.errors).toContain("compliance-digest: the record that 3 member(s) were not emailed today's digest by their own choice was not written: timeout: no answer within 5 s — the request was abandoned (it may still land)");
  });

  it("ample time: the record step records every opted-out member as before, after the 6c drain and the prunes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now());
    seed();
    const r = await runCron();
    expect(sent().map((e) => e.to_user_id)).toEqual([U(1)]);
    expect(records().map((e) => `${e.org_id}/${e.to_user_id}`).sort()).toEqual([`${ORG_A}/${U(2)}`, `${ORG_A}/${U(3)}`, `${ORG_B}/${U(2)}`].sort());
    expect(r.errors.filter((e) => e.startsWith("compliance-digest:"))).toEqual([]);
    const prunes = pruneCalls();
    const lastDrain = db.calls.map((c) => c.table).lastIndexOf("fetch");
    expect(recordReadAt()).toBeGreaterThan(Math.max(lastDrain, prunes.trash, prunes.push, prunes.outbox));
    expect(r.errors.filter((e) => /^(push-subscriptions|audit-outbox): not run/.test(e))).toEqual([]);
  });

  it("no time left when the record step starts (the 6c drain ran late): nothing recorded, nothing asked, and said — the digests already queued are untouched", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const T0 = Date.now();
    vi.setSystemTime(T0);
    seed();
    // the 6c drain's batch (the second send-queued call) returns 5 s before the run's end (300 s less 10 s)
    onDrain = (n) => { if (n === 2) vi.setSystemTime(T0 + 285_000); };
    const r = await runCron();
    expect(drainCalls).toBe(2);
    expect(sent().map((e) => e.to_user_id)).toEqual([U(1)]);
    expect(records()).toEqual([]);
    expect(db.calls.some((c) => c.table === "email_notifications" && c.op === "eq" && c.args[0] === "status" && c.args[1] === "not_emailed")).toBe(false);
    expect(r.errors).toContain("compliance-digest: 3 member(s) were not emailed today's digest by their own choice — not recorded: no time was left in this run");
  });

  it("the run's time runs out after the first chunk: the second chunk is not started — no insert after the deadline — and the members left are said", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const T0 = Date.now();
    vi.setSystemTime(T0);
    // one opted-in member and 151 opted-out ones: two record chunks (DIGEST_UID_CHUNK = 150)
    const out = Array.from({ length: 151 }, (_v, k) => U(100 + k));
    db.tables.org_members = [member(ORG_A, U(1)), ...out.map((u) => member(ORG_A, u))];
    db.tables.notifications = [U(1), ...out].map((u) => notice(ORG_A, u, "review_due", `Due ${u.slice(-3)}`, minutesAgo(10)));
    db.tables.notification_preferences = out.map((u) => ({ user_id: u, email_enabled: false }));
    let drained = false;
    onDrain = (n) => { if (n === 2) drained = true; };
    // the first record insert lands at 285 s — 5 s before the run's end
    let jumped = false;
    db.onExec = (table, op) => { if (drained && !jumped && table === "email_notifications" && op === "insert") { jumped = true; vi.setSystemTime(T0 + 285_000); } };
    const r = await runCron();
    expect(sent().map((e) => e.to_user_id)).toEqual([U(1)]);
    expect(records().length).toBe(150);
    const recordInserts = db.calls.filter((c) => c.table === "email_notifications" && c.op === "insert"
      && ((Array.isArray(c.args[0]) ? c.args[0] : [c.args[0]]) as Row[]).some((x) => x.status === "not_emailed"));
    expect(recordInserts.length).toBe(1);
    expect(r.errors).toContain("compliance-digest: 1 member(s) were not emailed today's digest by their own choice — not recorded: no time was left in this run");
  });
});
