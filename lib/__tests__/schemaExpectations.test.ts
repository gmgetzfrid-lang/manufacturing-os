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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  errors: {} as Record<string, { code?: string; message?: string }>,
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
    },
  };
});

import { EXPECTED_TABLES, EXPECTED_COLUMNS } from "@/lib/schemaExpectations";
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

/** Unlisted when the tripwire landed (2026-09-30). The regeneration that
 *  lists them is admin-and-org BKP-14 / intelligence ILIFE-12; this set may
 *  only shrink. */
const GRANDFATHERED = new Set(["answer_skills", "document_markups", "knowledge_line_traces", "link_rules", "process_flows"]);

/** table → the migration files that CREATE it (comments stripped; TEMP
 *  tables are not matched). */
function createdTables(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8").replace(/--[^\n]*/g, "");
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
    const missing = [...created.keys()].filter((t) => !listed.has(t) && !GRANDFATHERED.has(t))
      .map((t) => `${t} (${created.get(t)!.join(", ")})`);
    expect(missing, "add these to lib/schemaExpectations.ts EXPECTED_TABLES").toEqual([]);
  });

  it("every grandfathered name is a real created table — the exemption cannot hide a typo", () => {
    for (const t of GRANDFATHERED) expect(created.has(t), t).toBe(true);
  });
});
