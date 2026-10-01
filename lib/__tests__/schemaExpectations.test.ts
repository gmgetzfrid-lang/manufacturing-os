// projects Round G — REL-7: the schema-health panel reported green when the
// project-controls migration (20261013) was missing, because none of its
// seven tables or five feature columns were in lib/schemaExpectations.ts.
// Migrations are applied by hand, so the list IS the health check.
//
//   * the 20261013 rows exist and name the file that supplies them;
//   * /api/admin/schema-health reports red — and names 20261013 — when that
//     migration is unapplied, and green when it is;
//   * the tripwire: every table a migration creates has a row, so the next
//     migration cannot be forgotten the same way. Five tables were already
//     unlisted when the tripwire landed; they are grandfathered by name
//     (the list regeneration is admin-and-org BKP-14 / intelligence ILIFE-12)
//     and nothing may join them.
//
// MERGE NOTE: three in-flight branches create a table with no row here —
// document_share_accesses (DC-P1-share, 20261081), turnover_review_events
// (J2, 20261091), milestone_baseline_history (J6a, 20261099). Each merge
// adds its EXPECTED_TABLES row; none is grandfathered.
//
// admin-and-org Round G P2 — BKP-14 (intelligence ILIFE-12 / IRLS-12): the
// regeneration. The grandfather set is EMPTY; the scan now reads schema.sql
// too (eleven base tables — documents, document_versions, tickets,
// audit_logs, org_members… — were never probed); the tripwire runs BOTH ways
// (a row whose named file creates no such table fails — the phantom
// `statements`, scraped from a header comment, did); a dropped table is
// RETIRED, never expected. Plus the curated probes this package adds:
// org_configurations.data (ALOG-1 Done-when 4), the AI ledger's 20260916
// columns (GOV-4 Done-when 3) and the bump_share_access function (SHR-12
// Done-when 4) — and the route's function probe and PGRST205 handling.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  errors: {} as Record<string, { code?: string; message?: string }>,
  /** rpc name → the error PostgREST answers; default: the probe's own 22P02 (the function exists). */
  rpcErrors: {} as Record<string, { code?: string; message?: string }>,
  rpcCalls: [] as Array<{ fn: string; args: unknown }>,
}));

vi.mock("@/lib/supabaseAdmin", () => {
  function chain(table: string) {
    const c: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) => resolve({ data: null, error: state.errors[table] ?? null });
        }
        return () => {
          if (prop === "maybeSingle") {
            return Promise.resolve({ data: table === "org_members" ? { role: "Admin", roles: [] } : null, error: null });
          }
          return new Proxy(c, handler);
        };
      },
    };
    return new Proxy(c, handler);
  }
  return {
    supabaseAdmin: {
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: "u1" } }, error: null })) },
      from: (t: string) => chain(t),
      rpc: vi.fn(async (fn: string, args: unknown) => {
        state.rpcCalls.push({ fn, args });
        return { data: null, error: state.rpcErrors[fn] ?? { code: "22P02", message: 'invalid input syntax for type uuid: "schema-health-probe"' } };
      }),
    },
  };
});

import { EXPECTED_TABLES, EXPECTED_COLUMNS, EXPECTED_FUNCTIONS, RETIRED_TABLES } from "@/lib/schemaExpectations";
import { GET as schemaHealth } from "@/app/api/admin/schema-health/route";

const root = process.cwd();
const MIGRATIONS = join(root, "supabase", "migrations");
const PROJECT_CONTROLS = "20261013_project_controls_program.sql";
const PC_TABLES = ["change_orders", "checklist_items", "companies", "company_events", "project_checklists", "punch_items", "turnover_items"];
const PC_COLUMNS = [
  ["cost_documents", "rfq_group"], ["cost_documents", "intake_link_id"],
  ["project_intake_links", "purpose"], ["project_intake_links", "rfq_group"],
  ["cost_entries", "created_by_name"],
];

/** Unlisted when the tripwire landed (2026-09-30); emptied by the BKP-14
 *  regeneration (admin-and-org Round G P2). It stays empty. */
const GRANDFATHERED = new Set<string>();

const BASE = "schema.sql (base schema)";
const sqlOf = (file: string) =>
  readFileSync(file === BASE || file === "schema.sql" ? join(root, "supabase", "schema.sql") : join(MIGRATIONS, file), "utf8")
    .replace(/--[^\n]*/g, "");

/** table → the files that CREATE it — supabase/schema.sql (as BASE) and the
 *  numbered migrations (comments stripped; TEMP tables are not matched). */
function createdTables(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of [BASE, ...readdirSync(MIGRATIONS).filter((n) => /^\d{8}.*\.sql$/.test(n)).sort()]) {
    const sql = sqlOf(f);
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
      const t = m[1].toLowerCase();
      out.set(t, [...(out.get(t) ?? []), f]);
    }
  }
  return out;
}

describe("REL-7 — the project-controls migration is on the health check", () => {
  it("all seven 20261013 tables are expected, each naming 20261013", () => {
    for (const t of PC_TABLES) {
      const row = EXPECTED_TABLES.find((r) => r.table === t);
      expect(row, t).toBeDefined();
      expect(row!.migration, t).toBe(PROJECT_CONTROLS);
    }
    expect(existsSync(join(MIGRATIONS, PROJECT_CONTROLS))).toBe(true);
  });

  it("the five feature columns 20261013 adds to older tables are probed", () => {
    for (const [table, column] of PC_COLUMNS) {
      const row = EXPECTED_COLUMNS.find((c) => c.table === table && c.column === column);
      expect(row, `${table}.${column}`).toBeDefined();
      expect(row!.migration).toBe(PROJECT_CONTROLS);
      expect(row!.feature.length).toBeGreaterThan(0);
      // The probe is only honest if the migration really adds that column.
      const sql = readFileSync(join(MIGRATIONS, PROJECT_CONTROLS), "utf8");
      expect(sql, `${table}.${column}`).toMatch(new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column}\\b`));
    }
  });

  it("no table is listed twice", () => {
    const names = EXPECTED_TABLES.map((r) => r.table);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("REL-7 — /api/admin/schema-health goes red when 20261013 is unapplied", () => {
  const probe = () => schemaHealth(new NextRequest("http://test/api/admin/schema-health?orgId=o1", {
    headers: { authorization: "Bearer tok" },
  }));
  beforeEach(() => { state.errors = {}; });

  it("unapplied: the seven tables and five columns are missing, healthy is false, and 20261013 is the file to run", async () => {
    for (const t of PC_TABLES) state.errors[t] = { code: "42P01", message: `relation "${t}" does not exist` };
    // The older tables exist; only their 20261013 columns are absent.
    for (const t of ["cost_documents", "project_intake_links", "cost_entries"]) state.errors[t] = { code: "42703" };
    const res = await probe();
    expect(res.status).toBe(200);
    const body = await res.json() as {
      healthy: boolean; migrationsToRun: string[];
      missingTables: Array<{ table: string }>; missingColumns: Array<{ table: string; column: string }>;
    };
    expect(body.healthy).toBe(false);
    expect(body.migrationsToRun).toContain(PROJECT_CONTROLS);
    expect(body.missingTables.map((t) => t.table).sort()).toEqual([...PC_TABLES].sort());
    expect(body.missingColumns.map((c) => `${c.table}.${c.column}`).sort())
      .toEqual(PC_COLUMNS.map(([t, c]) => `${t}.${c}`).sort());
  });

  it("applied: healthy", async () => {
    const res = await probe();
    const body = await res.json() as { healthy: boolean; migrationsToRun: string[] };
    expect(body.healthy).toBe(true);
    expect(body.migrationsToRun).toEqual([]);
  });
});

describe("REL-7 tripwire — every table a migration creates is on the health check", () => {
  const created = createdTables();
  const listed = new Set(EXPECTED_TABLES.map((r) => r.table));

  it("the scan sees the migrations (not vacuous)", () => {
    expect(created.size).toBeGreaterThan(90);
    for (const t of PC_TABLES) expect(created.get(t), t).toContain(PROJECT_CONTROLS);
  });

  it("no created table is missing from EXPECTED_TABLES — add a row when a migration creates one", () => {
    const retired = new Set(RETIRED_TABLES.map((r) => r.table));
    const missing = [...created.keys()].filter((t) => !listed.has(t) && !GRANDFATHERED.has(t) && !retired.has(t))
      .map((t) => `${t} (${created.get(t)!.join(", ")})`);
    expect(missing, "add these to lib/schemaExpectations.ts EXPECTED_TABLES").toEqual([]);
  });

  it("the grandfather set is empty (BKP-14 regenerated the list)", () => {
    expect([...GRANDFATHERED]).toEqual([]);
  });

  it("BKP-14: every row names a file that really creates that table — no phantom (the scraped `statements` row is gone)", () => {
    expect(listed.has("statements")).toBe(false);
    const bad = EXPECTED_TABLES.filter((r) => !(created.get(r.table) ?? []).includes(r.migration))
      .map((r) => `${r.table} ← ${r.migration} (created by: ${(created.get(r.table) ?? ["nothing"]).join(", ")})`);
    expect(bad, "EXPECTED_TABLES rows whose named file does not create the table").toEqual([]);
  });

  it("BKP-14: the list covers every table supabase/ creates, schema.sql's included, less the retired", () => {
    for (const t of ["documents", "document_versions", "tickets", "audit_logs", "org_members", "collections", "libraries", "process_flows", "answer_skills", "link_rules", "document_markups"]) {
      expect(listed.has(t), t).toBe(true);
    }
    expect(listed.size).toBe(created.size - RETIRED_TABLES.length);
  });

  it("a retired table was created and dropped where the row says, and is never probed (IRLS-12: knowledge_line_traces must not exist)", () => {
    expect(RETIRED_TABLES.map((r) => r.table)).toEqual(["knowledge_line_traces"]);
    for (const r of RETIRED_TABLES) {
      expect(created.get(r.table), r.table).toContain(r.createdBy);
      expect(sqlOf(r.droppedBy)).toMatch(new RegExp(`DROP\\s+TABLE\\s+(IF\\s+EXISTS\\s+)?(public\\.)?${r.table}\\b`, "i"));
      expect(r.droppedBy > r.createdBy || r.droppedBy.startsWith(r.createdBy.slice(0, 8))).toBe(true);
      expect(listed.has(r.table)).toBe(false);
    }
  });
});

/** Does `file` add `column` to `table` — an ALTER … ADD COLUMN, or a line of
 *  its CREATE TABLE body? */
function fileAddsColumn(file: string, table: string, column: string): boolean {
  const sql = sqlOf(file);
  const alter = new RegExp(`ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(?:public\\.)?"?${table}"?\\s+[^;]*?ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${column}"?\\b`, "i");
  if (alter.test(sql)) return true;
  const create = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:public\\.)?"?${table}"?\\s*\\(`, "i");
  const m = create.exec(sql);
  if (!m) return false;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")" && --depth === 0) return new RegExp(`(^|[(,\\n])\\s*"?${column}"?\\s+[A-Za-z]`, "i").test(sql.slice(m.index + m[0].length, i));
  }
  return false;
}

describe("curated probes: each names the column or function the code needs and the file that supplies it", () => {
  it("every EXPECTED_COLUMNS row's file really adds that column (the first file named)", () => {
    const bad = EXPECTED_COLUMNS.filter((c) => !fileAddsColumn(c.migration.split(" (repair:")[0].trim(), c.table, c.column))
      .map((c) => `${c.table}.${c.column} ← ${c.migration}`);
    expect(bad).toEqual([]);
  });

  it("ALOG-1 Done-when 4: the org_configurations column the capability policy reads is probed — and it is `data`, never `value`", () => {
    const policy = readFileSync(join(root, "lib", "capabilityPolicy.ts"), "utf8");
    const reads = [...policy.matchAll(/\.from\("org_configurations"\)\s*\.select\("([a-z_]+)/g)].map((m) => m[1]);
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads)).toEqual(new Set(["data"]));
    expect(EXPECTED_COLUMNS).toContainEqual(expect.objectContaining({ table: "org_configurations", column: "data", migration: BASE }));
  });

  it("GOV-4 Done-when 3: every ledger column lib/ai/usageServer.ts reads that 20260916 adds is probed", () => {
    const usage = readFileSync(join(root, "lib", "ai", "usageServer.ts"), "utf8");
    const cols = (usage.match(/const USAGE_COLUMNS = "([^"]+)"/)?.[1] ?? "").split(",").map((c) => c.trim());
    const fromGovernance = cols.filter((c) => fileAddsColumn("20260916_ai_governance.sql", "ai_usage_events", c));
    expect(fromGovernance.sort()).toEqual(["est_cost_usd", "input_tokens", "model", "output_tokens"]);
    for (const c of fromGovernance) {
      expect(EXPECTED_COLUMNS, c).toContainEqual(expect.objectContaining({ table: "ai_usage_events", column: c, migration: "20260916_ai_governance.sql" }));
    }
  });

  it("SHR-12 Done-when 4: bump_share_access is probed, against the file that pins it, with an argument its uuid parameter refuses", () => {
    const fn = EXPECTED_FUNCTIONS.find((f) => f.fn === "bump_share_access")!;
    expect(fn).toBeDefined();
    expect(fn.signature).toBe("bump_share_access(uuid)");
    expect(sqlOf(fn.migration)).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+bump_share_access\s*\(\s*p_share\s+uuid\s*\)/i);
    // the route calls it with the same parameter name
    expect(readFileSync(join(root, "app", "api", "share", "resolve", "route.ts"), "utf8")).toMatch(/rpc\("bump_share_access", \{ p_share: /);
    expect(Object.keys(fn.probeArgs)).toEqual(["p_share"]);
    // not a uuid: the call cannot run the body (no counter moves)
    expect(String(fn.probeArgs.p_share)).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

describe("/api/admin/schema-health — functions, and a table PostgREST cannot find (PGRST205)", () => {
  const probe = () => schemaHealth(new NextRequest("http://test/api/admin/schema-health?orgId=o1", {
    headers: { authorization: "Bearer tok" },
  }));
  beforeEach(() => { state.errors = {}; state.rpcErrors = {}; state.rpcCalls = []; });

  it("present: the probe resolves the function and stops at its argument — healthy", async () => {
    const body = await (await probe()).json() as { healthy: boolean; checkedFunctions: number };
    expect(body.healthy).toBe(true);
    expect(body.checkedFunctions).toBe(EXPECTED_FUNCTIONS.length);
    expect(state.rpcCalls).toEqual([{ fn: "bump_share_access", args: { p_share: "schema-health-probe" } }]);
  });

  it("missing (PGRST202): named, with the file that supplies it, and the panel goes red", async () => {
    state.rpcErrors.bump_share_access = { code: "PGRST202", message: "Could not find the function public.bump_share_access(p_share) in the schema cache" };
    const body = await (await probe()).json() as { healthy: boolean; migrationsToRun: string[]; missingTables: Array<{ table: string; kind: string; migration: string }> };
    expect(body.healthy).toBe(false);
    expect(body.missingTables).toEqual([expect.objectContaining({ table: "bump_share_access(uuid)", kind: "function", migration: "20261081_dc_roundF_share_access_log.sql" })]);
    expect(body.migrationsToRun).toEqual(["20261081_dc_roundF_share_access_log.sql"]);
  });

  it("a table answered with PGRST205 is missing, not present", async () => {
    state.errors.process_flows = { code: "PGRST205", message: "Could not find the table 'public.process_flows' in the schema cache" };
    const body = await (await probe()).json() as { healthy: boolean; migrationsToRun: string[]; missingTables: Array<{ table: string; kind: string }> };
    expect(body.healthy).toBe(false);
    expect(body.missingTables).toEqual([expect.objectContaining({ table: "process_flows", kind: "table" })]);
    expect(body.migrationsToRun).toEqual(["20261017_process_flows.sql"]);
  });
});
