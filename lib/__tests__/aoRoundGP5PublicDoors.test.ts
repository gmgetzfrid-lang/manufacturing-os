// admin-and-org Round G — P5: the two public doors on the sign-up page, the
// attempt log's housekeeping, and who hears about an access request.
//
//   ORG-8   /api/auth/request-access answers "no such workspace", "you already
//           asked" and "request recorded" with ONE neutral 200 that names no
//           workspace; signup's short-name rejection spends an attempt; signup's
//           "name taken" repeats the name as typed, never the stored casing.
//   BILL-14 the shared per-IP window's branches (lib/publicDoorLimiter.ts):
//           a header-less caller shares one budget (it used to be exempt); a
//           missing table keeps today's open door (logged); any other failed
//           count refuses with a 503 instead of running unlimited.
//   ORG-12  the maintenance cron prunes signup_attempts in one step (no new
//           vercel.json entry); the table is never exported, for a stated reason.
//   PROD-15 the people told about an access request are exactly the people who
//           can see the pending list: the Admins.
// REGRESSION FIRST: a legitimate signup and a legitimate request still go
// through exactly as before; only the oracle answers changed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type QueuedResult = { data?: unknown; error?: unknown; count?: number; throws?: boolean };

const st = vi.hoisted(() => ({
  queues: {} as Record<string, QueuedResult[]>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  createUser: { data: { user: { id: "uid-new" } as { id: string } | null }, error: null as null | { message: string; code?: string } },
}));

function nextResult(table: string): QueuedResult {
  const q = st.queues[table];
  return (q && q.shift()) ?? { data: null, error: null };
}

function makeChain(table: string) {
  const chain: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        const r = nextResult(table);
        if (r.throws) return (_ok: unknown, bad: (e: unknown) => void) => bad(new Error("fetch failed"));
        return (resolve: (v: unknown) => void) =>
          resolve({ data: r.data ?? null, error: r.error ?? null, count: r.count ?? null });
      }
      return (...args: unknown[]) => {
        st.calls.push({ table, method: prop, args });
        if (prop === "maybeSingle" || prop === "single") {
          const r = nextResult(table);
          return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
        }
        return new Proxy(chain, handler);
      };
    },
  };
  return new Proxy(chain, handler);
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { admin: { createUser: vi.fn(async () => st.createUser), deleteUser: vi.fn(async () => ({ data: null, error: null })) } },
    from: (table: string) => makeChain(table),
    rpc: async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }),
  },
}));

import { POST as requestAccess } from "@/app/api/auth/request-access/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import {
  publicDoorClientIp, publicDoorVerdict, recordPublicDoorAttempt, PUBLIC_DOOR_MAX_PER_HOUR, UNKNOWN_CLIENT_IP,
  PUBLIC_DOOR_UNCHECKED_MESSAGE, REQUEST_ACCESS_ACKNOWLEDGEMENT,
} from "@/lib/publicDoorLimiter";
import { ACCESS_REQUEST_AUDIENCE, requestAccessTiming } from "@/lib/accessRequestOutcome";
import { EXPORT_EXCLUDED_TABLES } from "@/lib/exportTables";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const ROOT = process.cwd();
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

const req = (url: string, body: Record<string, unknown>, ip?: string) => new NextRequest(url, {
  method: "POST",
  headers: { "content-type": "application/json", ...(ip ? { "x-forwarded-for": ip } : {}) },
  body: JSON.stringify(body),
});
const ask = (body: Record<string, unknown>, ip = "9.9.9.9") => requestAccess(req("http://localhost/api/auth/request-access", body, ip));
const join_ = (body: Record<string, unknown>, ip = "9.9.9.9") => signup(req("http://localhost/api/auth/signup", body, ip));
const ASK = { displayName: "Greg", email: "Greg@Corp.com", orgName: "acme refining" };
const SIGNUP = { email: "Greg@Corp.com", password: "hunter22", displayName: "Greg", companyName: "acme refining" };
const callsOn = (table: string, method?: string) => st.calls.filter((c) => c.table === table && (!method || c.method === method));

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // ORG-24's response floor (600 ms on every answer) is pinned in
  // aoRoundGP5FixPass.test.ts; this suite tests the door's other behaviour
  requestAccessTiming.floorMs = 0;
  st.queues = {};
  st.calls = [];
  st.createUser = { data: { user: { id: "uid-new" } }, error: null };
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { warn.mockRestore(); });

describe("BILL-14 — the shared per-IP window, every branch deliberate", () => {
  const sb = supabaseAdmin as never;
  it("the client address: the first x-forwarded-for entry, else x-real-ip, else the one shared 'unknown' key", () => {
    const h = (headers: Record<string, string>) => new Request("http://x", { headers });
    expect(publicDoorClientIp(h({ "x-forwarded-for": " 1.2.3.4 , 5.6.7.8" }))).toBe("1.2.3.4");
    expect(publicDoorClientIp(h({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
    expect(publicDoorClientIp(h({}))).toBe(UNKNOWN_CLIENT_IP);
    expect(publicDoorClientIp(h({ "x-forwarded-for": " , " }))).toBe(UNKNOWN_CLIENT_IP);
  });
  it("a header-less caller is COUNTED under 'unknown' (it was exempt — an unlimited door) and refused at the same limit", async () => {
    st.queues.signup_attempts = [{ count: PUBLIC_DOOR_MAX_PER_HOUR }];
    const v = await publicDoorVerdict(sb, UNKNOWN_CLIENT_IP, "signup attempts");
    expect(v).toEqual({ allowed: false, status: 429, error: "Too many signup attempts from this network. Please wait a while and try again." });
    expect(callsOn("signup_attempts", "eq")[0].args).toEqual(["ip", "unknown"]);
  });
  it("under the limit: allowed; at the limit: 429", async () => {
    st.queues.signup_attempts = [{ count: PUBLIC_DOOR_MAX_PER_HOUR - 1 }, { count: PUBLIC_DOOR_MAX_PER_HOUR }];
    expect(await publicDoorVerdict(sb, "1.1.1.1", "access requests")).toEqual({ allowed: true });
    expect((await publicDoorVerdict(sb, "1.1.1.1", "access requests"))).toMatchObject({ allowed: false, status: 429 });
  });
  it("the table not there (20261010 not pasted — 42P01 / PGRST205): the door stays open as it always was, and the log says so", async () => {
    for (const error of [
      { code: "42P01", message: 'relation "public.signup_attempts" does not exist' },
      { code: "PGRST205", message: "Could not find the table 'public.signup_attempts' in the schema cache" },
    ]) {
      st.queues.signup_attempts = [{ error }];
      expect(await publicDoorVerdict(sb, "1.1.1.1", "signup attempts")).toEqual({ allowed: true, unchecked: "table-missing" });
    }
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/the per-IP window is not enforced until 20261010 is pasted/));
  });
  it("any other failed count (a denial, an outage, a thrown read) refuses with a 503 — never an unlimited door", async () => {
    st.queues.signup_attempts = [{ error: { code: "42501", message: "permission denied for table signup_attempts" } }, { throws: true }];
    expect(await publicDoorVerdict(sb, "1.1.1.1", "signup attempts")).toEqual({ allowed: false, status: 503, error: PUBLIC_DOOR_UNCHECKED_MESSAGE });
    expect(await publicDoorVerdict(sb, "1.1.1.1", "signup attempts")).toEqual({ allowed: false, status: 503, error: PUBLIC_DOOR_UNCHECKED_MESSAGE });
  });
  it("recording is a checked write: a refused insert is said in the log and answers false; it never throws", async () => {
    st.queues.signup_attempts = [{ error: { code: "57014", message: "statement timeout" } }, { data: null }];
    expect(await recordPublicDoorAttempt(sb, "1.1.1.1", "a@b.co", "attempt")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/the attempt was not recorded \(statement timeout\)/));
    expect(await recordPublicDoorAttempt(sb, "", null, "error")).toBe(true);
    expect(callsOn("signup_attempts", "insert").at(-1)!.args[0]).toEqual({ ip: "unknown", email: null, outcome: "error" });
  });
});

describe("ORG-8 — request-access is no longer an org-name oracle", () => {
  it("no such workspace, a request already waiting, and a recorded request get the SAME 200 and body — naming no workspace", async () => {
    // no such workspace
    st.queues = { signup_attempts: [{ count: 0 }], orgs: [{ data: null }] };
    const none = await ask(ASK);
    // a request already waiting
    st.queues = { signup_attempts: [{ count: 0 }], orgs: [{ data: { id: "org-1", name: "Acme Refining" } }], access_requests: [{ data: [{ id: "r1", status: "pending" }] }] };
    const dup = await ask(ASK);
    // a recorded request (the legitimate flow — still recorded exactly as before)
    st.queues = { signup_attempts: [{ count: 0 }], orgs: [{ data: { id: "org-1", name: "Acme Refining" } }], access_requests: [{ data: [] }, { data: { id: "r2" } }] };
    st.calls = [];
    const ok = await ask(ASK);
    const bodies = await Promise.all([none, dup, ok].map((r) => r.text()));
    expect([none.status, dup.status, ok.status]).toEqual([200, 200, 200]);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toEqual({ ok: true, message: REQUEST_ACCESS_ACKNOWLEDGEMENT });
    expect(bodies[0]).not.toMatch(/Acme|orgName/i);
    // REGRESSION: the real request is still written, with the workspace's stored name, and the address canonical
    const insert = callsOn("access_requests", "insert")[0];
    expect(insert.args[0]).toMatchObject({ org_id: "org-1", org_name: "Acme Refining", email: "greg@corp.com", status: "pending" });
  });
  it("every probe spends the window BEFORE the workspace is looked up", async () => {
    st.queues = { signup_attempts: [{ count: 0 }, { data: null }], orgs: [{ data: null }] };
    await ask(ASK);
    const insertAt = st.calls.findIndex((c) => c.table === "signup_attempts" && c.method === "insert");
    const orgAt = st.calls.findIndex((c) => c.table === "orgs");
    expect(insertAt).toBeGreaterThan(-1);
    expect(insertAt).toBeLessThan(orgAt);
    expect(st.calls[insertAt].args[0]).toMatchObject({ ip: "9.9.9.9", email: "greg@corp.com", outcome: "request-access" });
  });
  it("the window is shared with signup and enforced the same way: spent → 429; uncountable → 503; header-less callers share one budget", async () => {
    st.queues = { signup_attempts: [{ count: PUBLIC_DOOR_MAX_PER_HOUR }] };
    const limited = await ask(ASK);
    expect(limited.status).toBe(429);
    expect(callsOn("orgs")).toHaveLength(0);
    st.queues = { signup_attempts: [{ error: { code: "08006", message: "connection failure" } }] };
    const unchecked = await ask(ASK);
    expect(unchecked.status).toBe(503);
    expect((await unchecked.json()).error).toBe(PUBLIC_DOOR_UNCHECKED_MESSAGE);
    st.calls = [];
    st.queues = { signup_attempts: [{ count: PUBLIC_DOOR_MAX_PER_HOUR }] };
    expect((await requestAccess(req("http://localhost/api/auth/request-access", ASK))).status).toBe(429);   // no forwarded IP
    expect(callsOn("signup_attempts", "eq")[0].args).toEqual(["ip", "unknown"]);
  });
  it("a server fault while recording is a 500 that names no workspace and repeats no database text", async () => {
    st.queues = { signup_attempts: [{ count: 0 }], orgs: [{ data: { id: "org-1", name: "Acme Refining" } }], access_requests: [{ data: [] }, { error: { message: 'duplicate key value violates unique constraint "x"' } }] };
    const res = await ask(ASK);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toMatch(/Acme|duplicate key/);
  });
  it("the sign-up page's success screen no longer claims an admin received the request (the server cannot say)", () => {
    const page = src("app/signup/page.tsx");
    expect(page).not.toMatch(/Your organization&rsquo;s admin will receive your request/);
    expect(page).toMatch(/If a workspace named &ldquo;\{requestData\.orgName\.trim\(\)\}&rdquo; uses this service/);
  });
});

describe("ORG-8 — signup's own answers", () => {
  it("a too-short workspace name spends an attempt BEFORE it is refused", async () => {
    st.queues = { signup_attempts: [{ count: 0 }, { data: null }] };
    const res = await join_({ ...SIGNUP, companyName: "A" });
    expect(res.status).toBe(400);
    const insert = callsOn("signup_attempts", "insert");
    expect(insert).toHaveLength(1);
    expect(insert[0].args[0]).toMatchObject({ ip: "9.9.9.9", email: "greg@corp.com", outcome: "rejected" });
  });
  it("'name taken' repeats the name as TYPED — never the workspace's stored casing", async () => {
    st.queues = { signup_attempts: [{ count: 0 }, { data: null }], orgs: [{ data: { id: "org-1", name: "ACME Refining, Inc. (Baytown)" } }] };
    const res = await join_({ ...SIGNUP, companyName: "  acme refining  " });
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error).toBe('An organization named "acme refining" already exists. If you belong to this organization, use "Request Access" instead.');
    expect(error).not.toMatch(/ACME|Baytown/);
  });
  it("the window: spent → 429, uncountable → 503, missing table → the signup goes through as before", async () => {
    st.queues = { signup_attempts: [{ count: PUBLIC_DOOR_MAX_PER_HOUR }] };
    expect((await join_(SIGNUP)).status).toBe(429);
    st.queues = { signup_attempts: [{ error: { message: "upstream request timeout", code: "PGRST000" } }] };
    expect((await join_(SIGNUP)).status).toBe(503);
    // REGRESSION: 20261010 never pasted — the founding signup still completes
    st.queues = {
      signup_attempts: [{ error: { code: "42P01", message: 'relation "public.signup_attempts" does not exist' } }, { error: { code: "42P01", message: 'relation "public.signup_attempts" does not exist' } }],
      orgs: [{ data: null }, { data: { id: "org-new" } }], users: [{ data: [] }], org_members: [{ data: null }],
    };
    const res = await join_(SIGNUP);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ orgId: "org-new", userId: "uid-new" });
  });
});

describe("ORG-12 — the attempt log is pruned by the maintenance cron, and never exported", () => {
  it("one step on the existing cron calls prune_signup_attempts(); a missing function is a no-op, any other error is reported; no new vercel.json cron", () => {
    const c = src("app/api/cron/maintenance/route.ts");
    expect((c.match(/sb\.rpc\("prune_signup_attempts"\)/g) ?? []).length).toBe(1);
    expect(c).toContain('if (!isMissingFunction(signupPruneErr)) intakeLine(`signup-attempts: ${signupPruneErr.message}`);');
    expect(c).toContain("result.signupAttemptsPruned = true;");
    const vercel = JSON.parse(src("vercel.json")) as { crons?: unknown[] };
    expect((vercel.crons ?? []).length).toBeLessThanOrEqual(2);
  });
  it("the retention the function keeps (two days) is the one the limiter's header and the cron step state — the hour it reads plus a short tail", () => {
    const mig = src("supabase/migrations/20261010_signup_rate_limit.sql");
    expect(mig).toContain("DELETE FROM signup_attempts WHERE created_at < NOW() - INTERVAL '2 days';");
    expect(src("lib/publicDoorLimiter.ts")).toMatch(/`prune_signup_attempts\(\)` \(20261010\) keeps two days — the hour\s+\/\/ this window reads plus a short tail/);
    expect(src("app/api/cron/maintenance/route.ts")).toMatch(/prune_signup_attempts\(\) keeps two days: the hour the per-IP\s+\/\/\s+window reads/);
  });
  it("signup_attempts is excluded from the data-portability export, and the reason says what it holds", () => {
    expect(EXPORT_EXCLUDED_TABLES.signup_attempts).toMatch(/client IP and the address typed at the door/);
    expect(EXPORT_EXCLUDED_TABLES.signup_attempts).toMatch(/kept two days/);
    expect(EXPORT_EXCLUDED_TABLES.signup_attempts).not.toMatch(/no customer data/);
  });
});

describe("PROD-15 — the people told about an access request are the people who can see the pending list", () => {
  it("the notice's audience is the Admins", () => {
    expect([...ACCESS_REQUEST_AUDIENCE]).toEqual(["Admin"]);
  });
  it("…which is the set the pending list admits: the card on Admin → Users and access_requests_admin_select (20261023, the newest definition)", () => {
    const page = src("app/(protected)/admin/users/page.tsx");
    expect(page).toMatch(/const isAdmin = hasAnyRole\(\['Admin'\]\);/);
    // the pending read and the card both hang off isAdmin
    expect(page).toMatch(/isAdmin[\s\S]{0,400}access_requests|access_requests[\s\S]{0,400}isAdmin/);
    const policy = src("supabase/migrations/20261023_access_requests_scope_and_limit.sql");
    const body = policy.slice(policy.indexOf("CREATE POLICY access_requests_admin_select"), policy.indexOf("-- 3."));
    expect(body).toContain("AND (m.role = 'Admin' OR m.roles && ARRAY['Admin']::text[])");
    const listRoles = ["Admin"];
    expect([...ACCESS_REQUEST_AUDIENCE].sort()).toEqual(listRoles.sort());
  });
});

describe("20261238 — the DEC-30 one-paste shape (exercised on a throwaway PostgreSQL 16; cases in ORG-12's record)", () => {
  const sql = src("supabase/migrations/20261238_ao_roundG_signup_attempts_housekeeping.sql");
  const begin = sql.indexOf("\nBEGIN;");
  const commit = sql.indexOf("\nCOMMIT;");
  it("prerequisite check, then the counts-only inventory BEFORE the transaction, then BEGIN … COMMIT, then ONE final SELECT (check, ok, n)", () => {
    const guard = sql.indexOf("RAISE EXCEPTION '20261238 needs 20261010");
    const temp = sql.indexOf("CREATE TEMP TABLE _ao_g238_before AS");
    expect(guard).toBeGreaterThan(-1);
    expect(sql.indexOf("DROP TABLE IF EXISTS pg_temp._ao_g238_before;")).toBeLessThan(temp);
    expect(guard).toBeLessThan(temp);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    const tail = sql.slice(commit + "\nCOMMIT;".length);
    expect((tail.match(/^SELECT /gm) ?? []).length).toBe(1);
    expect(tail).toMatch(/^SELECT check_name AS "check", ok, n FROM \(/m);
    expect((sql.match(/\nCOMMIT;/g) ?? []).length).toBe(1);
  });
  it("the inventory is aggregate counts only — never a customer row", () => {
    const inv = sql.slice(sql.indexOf("CREATE TEMP TABLE _ao_g238_before AS"), begin);
    expect(inv).not.toMatch(/SELECT\s+(ip|email|\*)\b/i);
    // every value column is a COUNT(*) (the EXISTS (SELECT 1 …) probes inside them return no row)
    for (const m of inv.match(/\(SELECT [^;]*?FROM/g) ?? []) if (!m.startsWith("(SELECT 1 FROM")) expect(m, m).toMatch(/COUNT\(\*\)/);
    expect((inv.match(/\)::text/g) ?? []).length).toBe(5);
  });
  it("narrows only: no function, policy or trigger is (re-)created; the prune's body is untouched and probed; EXECUTE goes to service_role alone", () => {
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|POLICY|TRIGGER)/i);
    expect(sql).not.toMatch(/SECURITY\s+DEFINER/i);
    const tx = sql.slice(begin, commit);
    expect(tx).toContain("ALTER FUNCTION prune_signup_attempts() SET search_path = public;");
    expect(tx).toContain("REVOKE ALL ON FUNCTION prune_signup_attempts() FROM PUBLIC, anon, authenticated;");
    expect(tx).toContain("GRANT EXECUTE ON FUNCTION prune_signup_attempts() TO service_role;");
    expect(tx).toContain("DROP POLICY IF EXISTS access_requests_anyone_insert ON access_requests;");
    expect(tx).not.toMatch(/\b(DELETE|UPDATE|INSERT)\b/);
    expect(sql).toContain("prosrc LIKE '%DELETE FROM signup_attempts WHERE created_at < NOW() - INTERVAL ''2 days''%'");
  });
});
