// admin-and-org Round G, package P0 (verify and record) — the pins the
// record closes stand on. No application code changed in this package; each
// block below proves one claim a record makes about HEAD.
//
//   ALOG-1 done-when 1  a policy SAVED through POST /api/admin/capability-policy
//                       is READ back by loadCapabilityPolicyEntry, over a
//                       stand-in that honours column projection: a reader of
//                       any column but `data` gets nothing. The SQL evaluator
//                       reads the same column at its newest definition.
//   ALOG-12 dw 2 / 3    the route's audit `before` is read fresh at write time,
//                       with the service-role client and never through the
//                       60 s cache, and a grant rewrites the stored caps
//                       verbatim. `before` is NOT always the row the write
//                       replaced: revoke_member's grant strip leaves
//                       updated_at alone, so the compare-and-set cannot see
//                       it (see ALOG-12; the tripwire below).
//   ORG-2 done-when 3   replaying schema.sql then every numbered migration (the
//                       only supported install, schema.sql:3-27) leaves
//                       org_members with SELECT / UPDATE / INSERT / DELETE
//                       policies and no FOR ALL.
//   ORG-3 dw 1 / 3 / 4  access_requests ends with one org-correlated SELECT
//                       policy and no INSERT policy; the signup page checks
//                       res.ok before it shows "Request Sent".
//
// The census pins: every caller of the capability-policy loaders (ALOG-1)
// and every file naming libraries.write_access / admin_access (ALOG-13) is
// one its record lists. A new caller or reader fails the pin until the
// record names it; removing one keeps it green.
//
// NOT holding at HEAD (the records stay OPEN), each an `it.fails` tripwire
// that fails the suite the day the fix makes it hold, so the owner flips it
// to `it`:
//   ALOG-13 done-when 1  the permissions console still says the legacy
//                        read/write/admin matrix is GONE while a library
//                        write still names write_access / admin_access. The
//                        write side is a census over app/, lib/, hooks/,
//                        components/ and types/ (today: the wizard save AND
//                        createLibrary), not one file. Owner admin-and-org P8.
//   revoke_member        its grant strip does not stamp updated_at, so the
//                        policy route's compare-and-set cannot see it (the
//                        proposed finding in ALOG-12's record). Owner
//                        admin-and-org P8, which re-creates revoke_member.
// ORG-6's tripwire lives with the census it needs, in searchPathPin.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// Every non-test .ts / .tsx under the app's source roots, repo-relative.
let walked: string[] | null = null;
function sourceFiles(): string[] {
  if (walked) return walked;
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(process.cwd(), rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "__tests__") walk(p);
      } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  for (const root of ["app", "lib", "hooks", "components", "types"]) walk(root);
  walked = out.sort();
  return walked;
}
const filesMatching = (re: RegExp) => sourceFiles().filter((f) => re.test(src(f)));

// ── a PostgREST stand-in that honours column projection ─────────────────────
type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  tables: {} as Record<string, Row[]>,
}));

function table(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let cols: string[] | null = null;
  let op: { kind: "update"; patch: Row } | { kind: "insert"; row: Row } | null = null;
  let returning = false;
  const rows = () => (db.tables[name] ??= []);
  const project = (r: Row): Row => (cols ? Object.fromEntries(cols.map((c) => [c, r[c]])) : { ...r });
  const run = () => {
    if (op?.kind === "insert") { rows().push({ ...op.row }); return { data: null, error: null }; }
    const hit = rows().filter((r) => filters.every((f) => f(r)));
    if (op?.kind === "update") {
      for (const r of hit) Object.assign(r, op.patch);
      return { data: returning ? hit.map(project) : null, error: null };
    }
    return { data: hit.map(project), error: null };
  };
  const q = {
    select(c?: string) {
      if (op) returning = true;
      cols = c && c.trim() !== "*" ? c.split(",").map((s) => s.trim()) : null;
      return q;
    },
    eq(k: string, v: unknown) { filters.push((r) => r[k] === v); return q; },
    is(k: string, v: unknown) { filters.push((r) => (r[k] ?? null) === v); return q; },
    update(patch: Row) { op = { kind: "update", patch }; return q; },
    insert(row: Row) { op = { kind: "insert", row }; return q; },
    maybeSingle() {
      const out = run();
      return Promise.resolve({ data: (out.data as Row[] | null)?.[0] ?? null, error: null });
    },
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(run()).then(resolve, reject);
    },
  };
  return q;
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: {
      getUser: async () => (db.user ? { data: { user: db.user }, error: null } : { data: { user: null }, error: { message: "bad token" } }),
    },
    from: (t: string) => table(t),
    rpc: async () => ({ data: false, error: null }),
  },
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => table(t),
    auth: { getSession: async () => ({ data: { session: null } }) },
  },
}));

import {
  loadCapabilityPolicyEntry, __resetCapabilityPolicyCache, CAPABILITY_POLICY_ROUTE, type CapabilityPolicy,
} from "@/lib/capabilityPolicy";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { POST as policyRoute } from "@/app/api/admin/capability-policy/route";

const policy = (body: unknown) => policyRoute(new NextRequest("http://x" + CAPABILITY_POLICY_ROUTE, {
  method: "POST",
  headers: { authorization: "Bearer t", "content-type": "application/json" },
  body: JSON.stringify(body),
}));
const member = (uid: string, role: string) => ({ org_id: "o1", uid, role, roles: [role], email: `${uid}@x.io`, status: "active" });
const storedRow = () => (db.tables.org_configurations ?? []).find((r) => r.org_id === "o1" && r.key === "capability_policy");

beforeEach(() => {
  __resetCapabilityPolicyCache();
  db.user = { id: "a1" };
  db.tables = { org_members: [member("a1", "Admin"), member("v1", "Viewer")] };
});

describe("ALOG-1 done-when 1 — the capability policy round-trips through the one real column", () => {
  it("a save through the route is read back by loadCapabilityPolicyEntry — first an INSERT, then a compare-and-set UPDATE", async () => {
    const first = await policy({ op: "save", orgId: "o1", caps: { "ticket.assign": ["Admin", "DocCtrl"] } });
    expect(first.status).toBe(200);
    const row = storedRow()!;
    expect(Object.keys(row)).toContain("data");
    expect(Object.keys(row)).not.toContain("value");
    let read = await loadCapabilityPolicyEntry("o1", supabaseAdmin);
    expect(read.policy.caps?.["ticket.assign"]).toEqual(["Admin", "DocCtrl"]);
    expect(read.version).toBe(row.updated_at);

    // The route invalidated this process's cache on write; the second save
    // takes the UPDATE path, conditioned on the stamp it read.
    await new Promise((r) => setTimeout(r, 2));
    const second = await policy({ op: "save", orgId: "o1", caps: { "ticket.assign": ["Admin"] } });
    expect(second.status).toBe(200);
    expect(db.tables.org_configurations).toHaveLength(1);
    read = await loadCapabilityPolicyEntry("o1", supabaseAdmin);
    expect(read.policy.caps?.["ticket.assign"]).toEqual(["Admin"]);
  });

  it("the stand-in is not vacuous: a reader of the phantom `value` column gets nothing back", async () => {
    await policy({ op: "save", orgId: "o1", caps: { "ticket.assign": ["Admin"] } });
    const { data } = await supabaseAdmin.from("org_configurations").select("value")
      .eq("org_id", "o1").eq("key", "capability_policy").maybeSingle();
    expect(data).toEqual({ value: undefined });
  });

  it("the SQL evaluator reads `data` at its newest definition, and the base schema's column is `data`", () => {
    const dir = join(process.cwd(), "supabase", "migrations");
    const definers = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort()
      .filter((f) => /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:public\.)?org_capability_allows_for\s*\(/i.test(readFileSync(join(dir, f), "utf8")));
    const newest = readFileSync(join(dir, definers[definers.length - 1]), "utf8");
    const body = newest.slice(newest.search(/FUNCTION\s+(?:public\.)?org_capability_allows_for\s*\(/i));
    const fn = body.slice(0, body.indexOf("\n$$;"));
    expect(fn).toContain("SELECT data INTO v_val FROM org_configurations");
    expect(fn).not.toMatch(/SELECT\s+value\s+INTO/i);
    const schema = src("supabase/schema.sql");
    const create = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS org_configurations"));
    expect(create.slice(0, create.indexOf(");"))).toMatch(/\bdata JSONB NOT NULL DEFAULT '\{\}'/);
  });
});

describe("ALOG-1 done-when 2 — the record's census of the loaders' callers is complete", () => {
  // Grouped as ALOG-1's record groups them. A caller of the defaults-on-error
  // loader that is not listed here is one the record has not judged.
  const RECORDED = new Set([
    // the two console surfaces P9's marker must change
    "components/permissions/CapabilityPolicyEditor.tsx",
    "components/permissions/ViewAsSimulator.tsx",
    // field-facing: the hold opened / released / stale audience, and the
    // client holds gate (fail-open by design)
    "lib/holds.ts",
    // client affordances
    "app/(protected)/requests/page.tsx",
    "app/(protected)/requests/[id]/page.tsx",
    "app/(protected)/transmittals/page.tsx",
    "app/(protected)/admin/holds/page.tsx",
    "components/documents/HoldStrip.tsx",
    "components/documents/InspectorPanel.tsx",
    "components/documents/CheckoutStatusCell.tsx",
    "hooks/useTicketNotifications.ts",
    // through the entry: drafting-flow AUTHZ-7
    "app/api/tickets/workflow-action/route.ts",
    // strict
    "lib/adminGate.ts",
    "lib/transmittals.ts",
    "app/api/ai/usage/route.ts",
  ]);

  it("every caller of loadCapabilityPolicy / …Entry / …Strict outside the module is one the record lists", () => {
    expect(sourceFiles()).toContain("lib/capabilityPolicy.ts"); // the walk is not empty
    const callers = filesMatching(/\bloadCapabilityPolicy(?:Entry|Strict)?\s*\(/)
      .filter((f) => f !== "lib/capabilityPolicy.ts");
    expect(callers.length).toBeGreaterThan(0);
    expect(callers.filter((f) => !RECORDED.has(f))).toEqual([]);
  });
});

describe("ALOG-12 done-when 2 / 3 — the route's audit `before` and the grant path", () => {
  it("`before` is read fresh at write time: another admin's route write, not what this process had cached", async () => {
    db.tables.org_configurations = [{ org_id: "o1", key: "capability_policy", data: { caps: { "ticket.assign": ["Admin"] }, grants: [] }, updated_at: "2026-10-01T00:00:00Z" }];
    await loadCapabilityPolicyEntry("o1", supabaseAdmin); // primes the server cache with the old row
    // Another admin's write lands after that read.
    Object.assign(storedRow()!, { data: { caps: { "ticket.assign": ["Admin", "Supervisor"] }, grants: [] }, updated_at: "2026-10-01T00:00:01Z" });
    const res = await policy({ op: "save", orgId: "o1", caps: { "ticket.assign": ["Admin", "DocCtrl"] } });
    expect(res.status).toBe(200);
    const audit = (db.tables.audit_logs ?? []).find((r) => r.action === "CAPABILITY_POLICY_CHANGED")!;
    const before = (audit.details as { before: CapabilityPolicy }).before;
    expect(before.caps?.["ticket.assign"]).toEqual(["Admin", "Supervisor"]);
    const route = src("app/api/admin/capability-policy/route.ts");
    expect(route).not.toMatch(/loadCapabilityPolicy(Entry)?\(/);
    expect(route).toContain('.from("org_configurations").select("data, updated_at")');
  });

  it("a grant rewrites the stored caps verbatim and touches only the grants array", async () => {
    const caps = { "ticket.assign": ["Admin", "Supervisor"], "ticket.manage": ["Admin", "Manager"] };
    db.tables.org_configurations = [{ org_id: "o1", key: "capability_policy", data: { caps, grants: [] }, updated_at: "2026-10-01T00:00:00Z" }];
    const res = await policy({ op: "grant", orgId: "o1", uid: "v1", cap: "ticket.assign" });
    expect(res.status).toBe(200);
    const after = storedRow()!.data as CapabilityPolicy;
    expect(after.caps).toEqual(caps);
    expect(after.grants?.map((g) => [g.uid, g.cap])).toEqual([["v1", "ticket.assign"]]);
  });
});

// ── a policy census: schema.sql, then every numbered migration, in order ────
function finalPolicies(tableName: string): Map<string, { cmd: string; body: string; file: string }> {
  const dir = join(process.cwd(), "supabase", "migrations");
  const files = ["supabase/schema.sql", ...readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort().map((f) => `supabase/migrations/${f}`)];
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
  const out = new Map<string, { cmd: string; body: string; file: string }>();
  for (const file of files) {
    const txt = strip(src(file));
    const events: Array<{ at: number; drop: boolean; name: string; cmd?: string; body?: string }> = [];
    for (const m of txt.matchAll(/CREATE\s+POLICY\s+"?(\w+)"?\s+ON\s+(?:public\.)?(\w+)\b([\s\S]*?);/gi)) {
      if (m[2] !== tableName) continue;
      const cmd = (/\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i.exec(m[3])?.[1] ?? "ALL").toUpperCase();
      events.push({ at: m.index ?? 0, drop: false, name: m[1], cmd, body: m[3] });
    }
    for (const m of txt.matchAll(/DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?\s+ON\s+(?:public\.)?(\w+)/gi)) {
      if (m[2] === tableName) events.push({ at: m.index ?? 0, drop: true, name: m[1] });
    }
    events.sort((a, b) => a.at - b.at);
    for (const e of events) {
      if (e.drop) out.delete(e.name);
      else out.set(e.name, { cmd: e.cmd!, body: e.body!, file });
    }
  }
  return out;
}

describe("ORG-2 done-when 3 — a fresh install and a migrated database hold the same org_members policies", () => {
  it("schema.sql is the baseline only, and the migrations are mandatory", () => {
    const head = src("supabase/schema.sql").slice(0, 2000);
    expect(head).toContain("THIS FILE ALONE IS NOT A COMPLETE INSTALL");
    expect(head).toContain("The migrations are MANDATORY, not optional hardening.");
    expect(head).toContain("Never re-run this file on a live database");
  });

  it("replaying schema.sql then every numbered migration leaves SELECT / UPDATE / INSERT / DELETE — the baseline FOR ALL is dropped", () => {
    const final = finalPolicies("org_members");
    expect(Object.fromEntries([...final].map(([n, p]) => [n, p.cmd]))).toEqual({
      org_members_read: "SELECT",
      org_members_update: "UPDATE",
      org_members_write: "INSERT",
      org_members_delete: "DELETE",
    });
    expect([...final.values()].some((p) => p.cmd === "ALL")).toBe(false);
    // The baseline's FOR ALL text is still in schema.sql — frozen history,
    // replaced by 20260817 on every supported install.
    expect(src("supabase/schema.sql")).toMatch(/CREATE POLICY "org_members_write" ON org_members FOR ALL/);
    expect(final.get("org_members_write")!.file).toBe("supabase/migrations/20260817_org_members_escalation_and_config.sql");
    expect(final.get("org_members_delete")!.file).toBe("supabase/migrations/20261042_rp_phase6_revocation_and_succession.sql");
  });
});

describe("ORG-3 — access_requests is org-scoped, service-role-written, and the page tells the truth", () => {
  it("done-when 1 / 4: one SELECT policy, correlated on the row's org and additive-roles aware; no INSERT policy survives", () => {
    const final = finalPolicies("access_requests");
    expect([...final.keys()]).toEqual(["access_requests_admin_select"]);
    const sel = final.get("access_requests_admin_select")!;
    expect(sel.cmd).toBe("SELECT");
    expect(sel.file).toBe("supabase/migrations/20261023_access_requests_scope_and_limit.sql");
    expect(sel.body).toContain("m.org_id = access_requests.org_id");
    expect(sel.body).toContain("m.roles && ARRAY['Admin']::text[]");
    expect(src("supabase/migrations/20261023_access_requests_scope_and_limit.sql"))
      .toContain("ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS org_id uuid");
  });

  it("done-when 3: handleRequestAccess reads res.ok before it shows the success screen", () => {
    const page = src("app/signup/page.tsx");
    const handler = page.slice(page.indexOf("const handleRequestAccess"));
    const ok = handler.indexOf("if (!res.ok)");
    const sent = handler.indexOf("setRequestSent(true)");
    expect(ok).toBeGreaterThan(0);
    expect(sent).toBeGreaterThan(ok);
  });
});

describe("ALOG-13 — NOT holding at HEAD (owner admin-and-org P8)", () => {
  const CONSOLE = "app/(protected)/admin/permissions/page.tsx";
  // A write names the column as an object key: `write_access: …`. The
  // console comment names all three dead columns, read_access included
  // (integrator, at the merge: the final review found read_access missing).
  const WRITES = /\b(?:read|write|admin)_access\s*:/;

  // The record's census (ALOG-13 Partial): the console comment, two writers
  // (the wizard save and createLibrary) and three reading files.
  const RECORDED = new Set([
    CONSOLE,
    "app/(protected)/admin/libraries/page.tsx",
    "lib/libraryCollections.ts",
    "app/(protected)/documents/[libraryId]/page.tsx",
    "app/(protected)/documents/page.tsx",
  ]);

  it("every source file that names read_access / write_access / admin_access is one the record lists", () => {
    const naming = filesMatching(/\b(?:read_access|write_access|admin_access)\b/);
    expect(naming.length).toBeGreaterThan(0);
    expect(naming.filter((f) => !RECORDED.has(f))).toEqual([]);
  });

  // The tripwire below must not pass vacuously: if the console moved, src()
  // would throw inside it.fails and the suite would stay green. If this
  // fails, re-point the tripwire before anything else.
  it("the console file the tripwire reads exists, and the write census walks app/ and lib/", () => {
    expect(existsSync(join(process.cwd(), CONSOLE)), CONSOLE).toBe(true);
    expect(sourceFiles()).toContain("app/(protected)/admin/libraries/page.tsx");
    expect(sourceFiles()).toContain("lib/libraryCollections.ts");
  });

  // Flips only when the comment goes or EVERY writer stops: today both
  // app/(protected)/admin/libraries/page.tsx:116 and
  // lib/libraryCollections.ts:180-181 write the columns.
  it.fails("done-when 1: the console's 'GONE' comment does not coexist with a library write that still names read_access / write_access / admin_access", () => {
    const claimsGone = /read\/write\/admin role matrix is GONE/.test(src(CONSOLE));
    const stillWrites = filesMatching(WRITES).length > 0;
    expect(claimsGone && stillWrites).toBe(false);
  });
});

describe("revoke_member's grant strip — NOT holding at HEAD (proposed finding in ALOG-12's record; owner admin-and-org P8)", () => {
  // The newest definition, as P8 must re-create it (20261043 on f1ac550;
  // 20261161 since notifications N5 — this test scans, so it follows).
  const newestRevokeMember = () => {
    const dir = join(process.cwd(), "supabase", "migrations");
    const re = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:public\.)?revoke_member\s*\(/i;
    const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort()
      .filter((f) => re.test(readFileSync(join(dir, f), "utf8")));
    const sql = readFileSync(join(dir, files[files.length - 1]), "utf8");
    const body = sql.slice(sql.search(re));
    return { file: files[files.length - 1], fn: body.slice(0, body.indexOf("\n$$;")) };
  };
  const grantStrip = (fn: string) => {
    const at = fn.indexOf("UPDATE org_configurations");
    return at < 0 ? "" : fn.slice(at, fn.indexOf(";", at));
  };

  it("the newest revoke_member still strips the removed member's grants by rewriting `data`", () => {
    const { fn } = newestRevokeMember();
    expect(fn.length).toBeGreaterThan(0);
    expect(grantStrip(fn)).toMatch(/\bdata = jsonb_set\(data, '\{grants\}'/);
  });

  it.fails("the grant strip stamps updated_at, so the policy route's compare-and-set sees it", () => {
    expect(grantStrip(newestRevokeMember().fn)).toMatch(/\bupdated_at\s*=/);
  });
});
