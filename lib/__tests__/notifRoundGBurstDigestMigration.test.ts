// notifications Round G — N14 RAW-INSERT TAIL, the database half:
// supabase/migrations/20261197_notif_roundG_burst_claim_digest_rail.sql.
//
//   · PROD-16: claim_access_request_burst(uuid, uuid[], text, text) — the
//     access-request door's burst notice, its open-row check and its insert
//     taken under ONE per-org advisory lock; SECURITY DEFINER, search_path
//     pinned, EXECUTE to service_role only (DRLS-16); the row it writes is the
//     row the route's pre-paste path writes;
//   · NEDGE-20: email_notif_insert re-created from its NEWEST definition (found
//     by scanning supabase/migrations below this file) with exactly one line
//     added — a signed-in writer's compliance_digest row is refused (lineDiff);
//   · the DEC-30 one-paste shape: inventory (counts only) in a TEMP table
//     BEFORE the one BEGIN … COMMIT, ONE final (check, ok, n) statement.
// No database in this suite: the SQL is pinned by shape (the PostgreSQL 16 run
// is recorded under PROD-16 / NEDGE-20); the app half is in
// lib/__tests__/producersRoutes.test.ts and lib/__tests__/maintenanceDrain.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KIND_META } from "@/lib/notificationKinds";

const ROOT = process.cwd();
const DIR = join(ROOT, "supabase", "migrations");
const FILE = "20261197_notif_roundG_burst_claim_digest_rail.sql";
const FILES = readdirSync(DIR).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const SQL = read(FILE);
const strip = (sql: string) => sql.replace(/--[^\n]*/g, "");
const CODE = strip(SQL);
const SIG = "claim_access_request_burst(uuid, uuid[], text, text)";

/** Every `CREATE POLICY <name> ON <table>` statement, in [file, text] order. */
function policiesOf(name: string, table: string, files: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = new RegExp(`CREATE POLICY "?${name}"? ON ${table}\\b`, "g");
  for (const f of files) {
    const s = read(f);
    for (const m of s.matchAll(re)) {
      const lineStart = s.lastIndexOf("\n", m.index!) + 1;
      if (/^\s*--/.test(s.slice(lineStart, m.index!))) continue;
      // the statement ends at the first ";" that closes the WITH CHECK ( … )
      let depth = 0, i = m.index!;
      for (; i < s.length; i++) {
        if (s[i] === "(") depth++;
        else if (s[i] === ")") depth--;
        else if (s[i] === ";" && depth === 0) break;
      }
      out.push([f, s.slice(m.index!, i + 1)]);
    }
  }
  return out;
}
const lineDiff = (a: string, b: string) => {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
};
const fnBody = () => {
  const start = CODE.indexOf("CREATE OR REPLACE FUNCTION claim_access_request_burst(");
  return CODE.slice(start, CODE.indexOf("$$;", start) + 3);
};

describe("20261197 — one paste for the SQL editor (DEC-30)", () => {
  it("opens with a header that states the paste and deploy order; inventory in a TEMP table BEFORE the one BEGIN … COMMIT", () => {
    expect(SQL.startsWith("-- ─")).toBe(true);
    expect(SQL).toMatch(/PASTE AND DEPLOY ORDER: either order is safe\./);
    expect(SQL).toMatch(/42883 \/ PGRST202/);
    const temp = CODE.indexOf("CREATE TEMP TABLE notif_round_g_197_before");
    expect(temp).toBeGreaterThan(0);
    expect(CODE.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(CODE.match(/^COMMIT;/gm)).toHaveLength(1);
    expect(temp).toBeLessThan(CODE.indexOf("BEGIN;"));
  });

  it("ends with ONE statement after COMMIT: the (check, ok, n) probes, then the inventory rows", () => {
    const tail = CODE.slice(CODE.indexOf("COMMIT;") + "COMMIT;".length);
    const statements = tail.replace(/'(?:[^']|'')*'/g, "''").split(";").filter((x) => x.trim());
    expect(statements).toHaveLength(1);
    expect(tail).toMatch(/AS check,[\s\S]*?AS ok,\s*NULL::text AS n/);
    expect(tail).toMatch(/SELECT inventory, NULL::boolean, n FROM \(SELECT inventory, n FROM notif_round_g_197_before ORDER BY ord\) b;\s*$/);
    // four boolean probes (n NULL), then ONE information row (ok NULL) — integrator
    // fix pass, re-review minor 2: no boolean compares a live count read before
    // BEGIN with one read after COMMIT (live traffic moves it between the two)
    expect(tail.match(/^SELECT '/gm)).toHaveLength(5);
    expect(SQL).toMatch(/Expect: ok = true × 4; then ONE "AFTER" count \(ok NULL/);
    const after = tail.slice(tail.indexOf("SELECT 'AFTER:"));
    expect(after).toMatch(/^SELECT 'AFTER: [^']*information, not a check[^']*',\s+NULL::boolean,/);
    expect(tail).not.toMatch(/no row was changed/);
    expect(tail).not.toMatch(/=\s*\(SELECT n FROM notif_round_g_197_before/);
  });

  it("re-review minor 1: the policy probe checks the EXACT set on email_notifications — three policies in all, and those three names", () => {
    const tail = CODE.slice(CODE.indexOf("COMMIT;"));
    const probe = tail.slice(tail.indexOf("SELECT 'email_notifications has exactly three policies"), tail.indexOf("SELECT 'AFTER:"));
    expect(probe).toMatch(/\(SELECT COUNT\(\*\) = 3\s+AND COUNT\(\*\) FILTER \(WHERE policyname IN \('email_notif_insert', 'email_notif_select_own_or_admin', 'email_notif_update_admin_requeue'\)\) = 3\s+FROM pg_policies\s+WHERE schemaname = 'public' AND tablename = 'email_notifications'\),/);
    // the count runs over EVERY policy on the table — no name filter in its WHERE
    expect(probe).not.toMatch(/WHERE schemaname = 'public' AND tablename = 'email_notifications'\s+AND policyname IN/);
  });

  it("the inventory is aggregate counts only — never a customer row", () => {
    const inv = CODE.slice(CODE.indexOf("CREATE TEMP TABLE"), CODE.indexOf("BEGIN;"));
    const branches = inv.split(/UNION ALL/);
    expect(branches).toHaveLength(4);
    for (const b of branches) expect(b).toMatch(/COUNT\(\*\)/);
    expect(inv).not.toMatch(/SELECT \*|\btitle\b|\bbody\b|actor_name|display_name|to_email|subject/i);
    // the forged-shape count never casts a value that is not a timestamp (a CASE guards the cast)
    expect(inv).toMatch(/CASE WHEN COALESCE\(e\.metadata ->> 'through', ''\) ~ '[^']+'\s+THEN \(e\.metadata ->> 'through'\)::timestamptz/);
  });

  it("changes no row: no UPDATE, DELETE or INSERT outside the function's body", () => {
    const outside = CODE.replace(fnBody(), "");
    expect(outside).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\b/gm);
  });
});

describe("20261197 — PROD-16: the burst slot claimed under one per-org lock", () => {
  it("is defined once in the sequence (here), SECURITY DEFINER with search_path pinned (DRLS-16), EXECUTE to service_role only", () => {
    const everywhere = FILES.filter((f) => /CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?claim_access_request_burst\(/.test(strip(read(f))));
    expect(everywhere).toEqual([FILE]);
    const head = fnBody().slice(0, fnBody().indexOf("AS $$"));
    expect(head).toMatch(/RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public/);
    expect(CODE).toContain(`REVOKE ALL ON FUNCTION ${SIG} FROM PUBLIC, anon, authenticated;`);
    expect(CODE).toContain(`GRANT EXECUTE ON FUNCTION ${SIG} TO service_role;`);
    expect(CODE.match(/GRANT[^;]*claim_access_request_burst[^;]*;/g)).toEqual([`GRANT EXECUTE ON FUNCTION ${SIG} TO service_role;`]);
    // it never reads the caller's uid: nothing for a NULL auth.uid() branch to misread (DRLS-16's sweep)
    expect(fnBody()).not.toMatch(/auth\.uid\(\)/);
  });

  it("takes the org's transaction-scoped advisory lock BEFORE the open-row read and the insert", () => {
    const body = fnBody();
    const lock = body.indexOf("PERFORM pg_advisory_xact_lock(hashtextextended('access-request-burst:' || p_org::text, 0));");
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(body.indexOf("SELECT COUNT(DISTINCT n.user_id) INTO v_already"));
    expect(lock).toBeLessThan(body.indexOf("INSERT INTO notifications"));
    // the insert's own NOT EXISTS is the check (a READ COMMITTED statement after the lock sees the last holder's rows)
    expect(body).toMatch(/INSERT INTO notifications[\s\S]*AND NOT EXISTS \(SELECT 1 FROM notifications n[\s\S]*n\.read_at IS NULL[\s\S]*n\.actor_user_id IS NULL\);/);
  });

  it("writes the row the route's pre-paste path writes — same kind, link, resource, no actor, metadata — to ACTIVE members only, once per member", () => {
    const body = fnBody();
    expect(body).toMatch(/SELECT p_org, r\.uid, 'access_request_pending', p_title, p_body, '\/admin\/users', 'org', p_org::text, NULL, NULL,\s+jsonb_build_object\('accessRequestBurst', true\)/);
    expect(body).toMatch(/FROM \(SELECT DISTINCT u AS uid FROM unnest\(p_recipients\) AS u WHERE u IS NOT NULL\) r/);
    expect(body).toMatch(/EXISTS \(SELECT 1 FROM org_members m\s+WHERE m\.org_id = p_org AND m\.uid = r\.uid AND m\.status = 'active'\)/);
    // the route's fallback (before the paste) and its claim agree
    const route = readFileSync(join(ROOT, "app/api/auth/request-access/route.ts"), "utf8");
    expect(route).toMatch(/supabaseAdmin\.rpc\("claim_access_request_burst", \{\s+p_org: orgId, p_recipients: recipients, p_title: notice\.title, p_body: notice\.body,\s+\}\)/);
    expect(route).toMatch(/if \(!isMissingFunction\(claim\.error\)\) \{[\s\S]*?no notice was written for this request`\);\s+return;\s+\}/);
    expect(route).toMatch(/kind: "access_request_pending" as const,\s+\.\.\.notice,\s+link: "\/admin\/users",\s+resourceType: ACCESS_REQUEST_BURST_RESOURCE_TYPE,\s+resourceId: orgId,\s+metadata: \{ accessRequestBurst: true \},/);
    expect(readFileSync(join(ROOT, "lib/accessRequestOutcome.ts"), "utf8")).toContain('export const ACCESS_REQUEST_BURST_RESOURCE_TYPE = "org";');
    // the one kind the database writes here is a registered kind (TAX-11: no kind outside the registry)
    expect(Object.keys(KIND_META)).toContain("access_request_pending");
    expect([...body.matchAll(/'([a-z_]+_pending)'/g)].map((m) => m[1])).toEqual(["access_request_pending", "access_request_pending", "access_request_pending"]);
  });
});

describe("20261197 — NEDGE-20: email_notif_insert re-created from its NEWEST definition, plus one line", () => {
  const before = policiesOf("email_notif_insert", "email_notifications", FILES.filter((f) => f < FILE)).at(-1)!;
  const mine = policiesOf("email_notif_insert", "email_notifications", [FILE]);

  it("the newest earlier definition is found by scanning the sequence, and this file defines it once (after dropping it)", () => {
    expect(before, "an earlier definition of email_notif_insert").toBeTruthy();
    expect(before[0] < FILE).toBe(true);
    expect(mine).toHaveLength(1);
    expect(CODE).toContain("DROP POLICY IF EXISTS email_notif_insert ON email_notifications;");
  });

  it("removes no line and adds exactly one: a signed-in writer's row is never a compliance_digest", () => {
    const d = lineDiff(before[1], mine[0][1]);
    expect(d.onlyInA).toEqual([]);
    expect(d.onlyInB).toEqual(["    AND event_type <> 'compliance_digest'"]);
  });

  it("touches no other policy, trigger or function on email_notifications", () => {
    expect(CODE.match(/CREATE POLICY/g)).toHaveLength(1);
    expect(CODE.match(/DROP POLICY/g)).toHaveLength(1);
    expect(CODE).not.toMatch(/CREATE TRIGGER|DROP TRIGGER|enforce_email_requeue_columns\(\)\s*RETURNS|stamp_email_queued_by\(\)\s*RETURNS/);
  });

  it("the cron's own digest is the only producer of the event type — nothing in the app queues it from a browser", () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(join(ROOT, d), { withFileTypes: true })) {
        const p = `${d}/${n.name}`;
        if (n.isDirectory()) { if (n.name !== "node_modules" && n.name !== "__tests__" && !n.name.startsWith(".")) walk(p); }
        else if (/\.tsx?$/.test(n.name) && /event_type: "compliance_digest"|eventType: "compliance_digest"/.test(readFileSync(join(ROOT, p), "utf8"))) hits.push(p);
      }
    };
    for (const d of ["app", "lib", "components", "hooks"]) walk(d);
    expect(hits).toEqual(["app/api/cron/maintenance/route.ts"]);
  });
});
