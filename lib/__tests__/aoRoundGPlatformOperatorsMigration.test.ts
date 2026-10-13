// admin-and-org Round G, package P6 — BILL-5 (DEC-99): 20261177
// gives the platform-operator list its home in platform_settings and
// re-asserts that the table is service-role only. Shape tests over the
// one-paste file (DEC-30: guard, TEMP inventory of counts before BEGIN, one
// transaction, ONE final (check, ok, n) SELECT) and over what it relies on:
// platform_settings' only definition (20260920) and the app's reader of the
// row (lib/storageUsage.ts readPlatformOperators). It re-creates no function,
// policy or trigger, so there is no definition to carry forward byte-faithful.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_OPERATORS_KEY, PLATFORM_OPERATORS_MIGRATION, STORAGE_LIMITS_KEY } from "@/lib/storageUsage";

const root = process.cwd();
const MIGRATIONS = join(root, "supabase", "migrations");
const FILE = "20261177_ao_roundG_platform_operators.sql";
const raw = readFileSync(join(MIGRATIONS, FILE), "utf8");
const sql = raw.replace(/--[^\n]*/g, "");
const numbered = readdirSync(MIGRATIONS).filter((n) => /^\d{8}.*\.sql$/.test(n)).sort();
const ddl = sql.slice(sql.indexOf("\nBEGIN;"), sql.indexOf("\nCOMMIT;"));
const verification = sql.slice(sql.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);

describe("20261177 — the one-paste shape (DEC-30)", () => {
  it("is the number reserved for this package, and the app names it", () => {
    expect(numbered.filter((f) => f.startsWith("20261177"))).toEqual([FILE]);
    expect(PLATFORM_OPERATORS_MIGRATION).toBe(FILE);
  });

  it("the platform_settings guard, then the TEMP inventory BEFORE ONE transaction, then ONE final (check, ok, n) SELECT ending the file", () => {
    const guard = sql.indexOf("IF to_regclass('public.platform_settings') IS NULL THEN");
    const temp = sql.indexOf("CREATE TEMP TABLE _ao_g77_before");
    expect(guard).toBeGreaterThan(-1);
    expect(sql).toMatch(/RAISE EXCEPTION '20261177 needs 20260920/);
    expect(guard).toBeLessThan(temp);
    expect(temp).toBeLessThan(sql.indexOf("\nBEGIN;"));
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    const tail = verification.trim();
    expect(tail.split(/;\s*$/m).filter((x) => x.trim()).length).toBe(1);
    expect(tail).toMatch(/^SELECT '[^']+' AS check,[\s\S]*AS ok,\s*NULL::text AS n/);
    expect(tail).toMatch(/UNION ALL SELECT inventory, NULL, n FROM _ao_g77_before;$/);
    expect(raw).toMatch(/APPLIED BY HAND \(DEC-30\)/);
  });

  it("the inventory is aggregate counts only — never rows", () => {
    const inv = sql.slice(sql.indexOf("CREATE TEMP TABLE"), sql.indexOf("\nBEGIN;"));
    const parts = inv.split(/\nUNION ALL\n/);
    expect(parts.length).toBe(6);
    for (const sel of parts) expect(sel).toMatch(/COUNT\(\*\)/);
    expect(inv).not.toMatch(/SELECT \*|row_to_json|json_agg|string_agg|array_agg|to_jsonb\(/i);
    // a re-run, the ceiling row it must not touch, the operators it must keep, and the lock it re-asserts
    expect(inv).toMatch(/WHERE key = 'storage_limits'/);
    expect(inv).toMatch(/WHERE key = 'platform_operators'/);
    expect(inv).toMatch(/has_table_privilege\(r\.role, 'public\.platform_settings', p\.priv\)/);
    expect(inv).toMatch(/FROM pg_policies WHERE schemaname = 'public' AND tablename = 'platform_settings'/);
  });

  it("the transaction: RLS on, ALL revoked from the client roles, the empty list seeded without clearing one, a comment — nothing else", () => {
    const stmts = ddl.split(";").map((x) => x.trim().replace(/\s+/g, " ")).filter((x) => x && x !== "BEGIN");
    expect(stmts).toEqual([
      "ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY",
      "REVOKE ALL ON platform_settings FROM public, anon, authenticated",
      `INSERT INTO platform_settings (key, value) VALUES ('${PLATFORM_OPERATORS_KEY}', '{"uids": []}'::jsonb) ON CONFLICT (key) DO NOTHING`,
      expect.stringMatching(/^COMMENT ON TABLE platform_settings IS 'Deployment-wide settings, service-role only/),
    ]);
    // statements only (a probe's label may name a policy or a grant)
    expect(sql).not.toMatch(/^\s*(CREATE|DROP|ALTER)\s+(OR\s+REPLACE\s+)?(POLICY|FUNCTION|TRIGGER|INDEX|UNIQUE\s+INDEX)\b/im);
    // the only table statements: the TEMP inventory's, and RLS on platform_settings
    const tableStmts = [...sql.matchAll(/^\s*(CREATE|DROP|ALTER)\s+(TEMP\s+)?TABLE\b[^\n]*/gim)].map((m) => m[0].trim());
    expect(tableStmts).toEqual([
      "DROP TABLE IF EXISTS pg_temp._ao_g77_before;",
      "CREATE TEMP TABLE _ao_g77_before AS",
      "ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;",
    ]);
    expect(sql).not.toMatch(/^\s*GRANT\s/im);
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE\s+FROM)\s+platform_settings\b/im); // the ceiling row is never touched
    expect(sql).not.toMatch(/SECURITY DEFINER/i);
  });

  it("the probes check each limb: RLS, no client privilege, no policy, the service role, the row's shape, the ceiling untouched, the operators kept", () => {
    expect(verification).toMatch(/SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass\('public\.platform_settings'\)/);
    expect(verification).toMatch(/NOT EXISTS \(SELECT 1 FROM \(VALUES \('public'\), \('anon'\), \('authenticated'\)\) r\(role\), \(VALUES \('SELECT'\), \('INSERT'\), \('UPDATE'\), \('DELETE'\)\) p\(priv\)/);
    expect(verification).toMatch(/NOT EXISTS \(SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'platform_settings'\)/);
    for (const p of ["SELECT", "INSERT", "UPDATE"]) expect(verification).toContain(`has_table_privilege('service_role', 'public.platform_settings', '${p}')`);
    expect(verification).toMatch(/key = 'platform_operators' AND jsonb_typeof\(value->'uids'\) = 'array'/);
    expect(verification).toMatch(/WHERE key = 'storage_limits'\)::text = \(SELECT n FROM _ao_g77_before WHERE k = 'limits'\)/);
    expect(verification).toMatch(/= \(SELECT n FROM _ao_g77_before WHERE k = 'operators'\)/);
    // every probe carries ok with n NULL; the after rows carry n with ok NULL
    expect((verification.match(/, NULL\n/g) ?? []).length + 1).toBeGreaterThanOrEqual(7);
    expect(verification).toMatch(/'after: platform operators registered[^']*'(?:'[^']*)*, NULL,/);
  });
});

describe("20261177 — what it relies on", () => {
  it("platform_settings is defined once (20260920), service-role only; no migration between touches it", () => {
    const touching = numbered.filter((f) => /platform_settings/.test(readFileSync(join(MIGRATIONS, f), "utf8").replace(/--[^\n]*/g, "")));
    expect(touching).toEqual(["20260920_per_user_keys_real_limits.sql", FILE]);
    const base = readFileSync(join(MIGRATIONS, "20260920_per_user_keys_real_limits.sql"), "utf8");
    expect(base).toMatch(/CREATE TABLE IF NOT EXISTS platform_settings \(\n  key TEXT PRIMARY KEY,\n  value JSONB NOT NULL,/);
    expect(base).toMatch(/ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;\nREVOKE ALL ON platform_settings FROM public, anon, authenticated;/);
  });
  it("the app reads the same key and shape the file seeds, and never writes the operator row", () => {
    const usage = readFileSync(join(root, "lib/storageUsage.ts"), "utf8");
    expect(PLATFORM_OPERATORS_KEY).toBe("platform_operators");
    expect(STORAGE_LIMITS_KEY).toBe("storage_limits");
    expect(usage).toMatch(/\.from\("platform_settings"\)\.select\("value"\)\.eq\("key", PLATFORM_OPERATORS_KEY\)\.maybeSingle\(\)/);
    for (const f of ["lib/storageUsage.ts", "app/api/admin/storage-stats/route.ts"]) {
      const s = readFileSync(join(root, f), "utf8");
      // the only platform_settings write in the app is the ceiling upsert, keyed STORAGE_LIMITS_KEY
      const writes = [...s.matchAll(/from\("platform_settings"\)\.(upsert|insert|update|delete)\(\{?\s*\n?\s*(key: [A-Z_]+)?/g)];
      for (const w of writes) expect(w[2], f).toBe("key: STORAGE_LIMITS_KEY");
    }
  });
  it("the header's registration line keys the same row, and is idempotent", () => {
    expect(raw).toMatch(/--\s+WHERE platform_settings\.key = 'platform_operators' AND u\.email = 'you@example\.com'\n--\s+AND NOT \(COALESCE\(platform_settings\.value->'uids', '\[\]'::jsonb\) \? u\.id::text\);/);
  });
});
