// admin-and-org Round G, package P13 — the shape of
// supabase/migrations/20261219_ao_roundG_audit_node_trail_and_outbox.sql
// (ALOG-16 and the drafting-flow EVID-6 outbox), pinned at test time:
//   * audit_logs_admin_trail is re-created from its NEWEST definition — found
//     by SCANNING the sequence, so a re-creation folded in at merge moves the
//     pin — with ONE added clause; the paste picks the body by what is
//     applied (20261157's when its function exists, else 20261142's), and each
//     EXECUTEd text is lineDiffed against its source: nothing lost, only the
//     ALOG-16 comment and its three lines added;
//   * audit_row_node_manageable is SECURITY INVOKER, no SET clause, names
//     schema-qualified, EXECUTE for the roles the overlay is evaluated for;
//   * the outbox table is RLS-on, policy-less, the service role's alone;
//   * the DEC-30 one-paste shape (counts-only inventory before BEGIN, one
//     BEGIN / COMMIT, the 20261142 floor checked before any DDL, ONE final
//     SELECT of (check, ok, n)).
// The file was also exercised on PostgreSQL 16 (lib/__tests__/rls/
// aoP13AuditNodeTrail.test.ts, `npm run test:db`): world C on the replay,
// a re-paste, world B on a copy, world A's stop, and the outbox grants.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const migDir = join(root, "supabase", "migrations");
const FILE = "20261219_ao_roundG_audit_node_trail_and_outbox.sql";
const mig = (f: string) => readFileSync(join(migDir, f), "utf8");
const M = mig(FILE);
const code = (sql: string) => sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const numbered = () => readdirSync(migDir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();

function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b);
}
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}
/** A source's policy text: from CREATE POLICY to its closing `\n  );`. */
const policyOf = (sql: string) => between(sql, "CREATE POLICY audit_logs_admin_trail ON audit_logs", "\n  );");
/** One of this file's EXECUTEd bodies. */
const worldBody = (tag: "world_b" | "world_c") => policyOf(between(M, `EXECUTE $${tag}$\nCREATE POLICY`, `\n$${tag}$;`).slice(`EXECUTE $${tag}$\n`.length));

const CLAUSE = [
  "    AND ((COALESCE(action, '') NOT IN ('NODE_ACL_CHANGED', 'OWNER_ASSIGNED', 'OWNER_CLEARED', 'ACCESS_RECERTIFIED')",
  "          AND left(COALESCE(action, ''), 11) <> 'OWNER_TEAM_')",
  "         OR audit_row_node_manageable(resource_type, resource_id))",
];

describe("ALOG-16 — audit_logs_admin_trail re-created from its NEWEST definition + ONE clause", () => {
  const earlier = () => numbered().filter((f) => f < FILE && mig(f).includes("CREATE POLICY audit_logs_admin_trail"));

  it("the newest earlier definitions are found by scanning (today 20261157 §7, and 20261142 §2 for a database without 20261157)", () => {
    const ds = earlier();
    expect(ds[ds.length - 1]).toBe("20261157_prj_roundG_server_remainders.sql");
    const withoutRef = ds.filter((f) => !policyOf(mig(f)).includes("audit_row_project_ref_visible"));
    expect(withoutRef[withoutRef.length - 1]).toBe("20261142_prj_roundG_project_audit_rows.sql");
  });

  it("world C (20261157 applied): nothing of 20261157's body is lost; only the ALOG-16 comment and its clause are added", () => {
    const ds = earlier();
    const { onlyInA, onlyInB } = lineDiff(policyOf(mig(ds[ds.length - 1])), worldBody("world_c"));
    expect(onlyInA).toEqual([]);
    expect(onlyInB.filter((l) => !/^\s*--/.test(l))).toEqual(CLAUSE);
    expect(onlyInB.filter((l) => /^\s*--/.test(l)).length).toBeGreaterThan(0);
    expect(worldBody("world_c")).toMatch(/AS RESTRICTIVE FOR SELECT\s*\n\s*USING \(/);
  });

  it("world B (20261142 applied, 20261157 not): nothing of 20261142's body is lost; only the same clause is added", () => {
    const src = earlier().filter((f) => !policyOf(mig(f)).includes("audit_row_project_ref_visible")).pop()!;
    const { onlyInA, onlyInB } = lineDiff(policyOf(mig(src)), worldBody("world_b"));
    expect(onlyInA).toEqual([]);
    expect(onlyInB.filter((l) => !/^\s*--/.test(l))).toEqual(CLAUSE);
    expect(worldBody("world_b")).not.toContain("audit_row_project_ref_visible");
  });

  it("the body is chosen by what is applied, and the 20261142 floor is checked before any DDL (the paste stops otherwise)", () => {
    const c = code(M);
    const choose = between(c, "DO $alog16$", "$alog16$;");
    expect(choose).toContain("IF to_regprocedure('public.audit_row_project_ref_visible(text, text, text, jsonb)') IS NULL THEN");
    expect(choose.indexOf("EXECUTE $world_b$")).toBeLessThan(choose.indexOf("ELSE"));
    expect(choose.indexOf("EXECUTE $world_c$")).toBeGreaterThan(choose.indexOf("ELSE"));
    // the census (lib/__tests__/projectsRls.test.ts) reads the last variant: the newest body comes last
    expect(M.lastIndexOf("CREATE POLICY audit_logs_admin_trail")).toBeGreaterThan(M.indexOf("$world_c$"));
    const guard = between(c, "DO $guard$", "$guard$;");
    expect(guard).toContain("IF to_regprocedure('public.audit_row_project_visible(text, text)') IS NULL THEN");
    expect(guard).toContain("RAISE EXCEPTION 'Apply 20261142_prj_roundG_project_audit_rows.sql first");
    expect(c.indexOf("DO $guard$")).toBeLessThan(c.indexOf("CREATE OR REPLACE FUNCTION public.audit_row_node_manageable"));
    expect(c.indexOf("DO $guard$")).toBeGreaterThan(c.indexOf("BEGIN;"));
  });

  it("the node-manager limb: SECURITY INVOKER, no SET clause, names schema-qualified, the drawer's admitters per type, false for anything else", () => {
    const f = between(code(M), "CREATE OR REPLACE FUNCTION public.audit_row_node_manageable(p_type text, p_id text)", "\n$$;");
    expect(f).toMatch(/RETURNS boolean LANGUAGE sql STABLE AS \$\$/);
    expect(f).not.toMatch(/SECURITY DEFINER|SET search_path/);
    expect(f).toContain("WHEN p_id IS NULL OR p_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN false");
    for (const [t, alias, owner] of [
      ["library", "l", "public.user_is_effective_owner(NULL::uuid, NULL::uuid, l.id, auth.uid())"],
      ["collection", "c", "public.user_is_effective_owner(NULL::uuid, c.id, c.library_id, auth.uid())"],
      ["document", "d", "public.user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid())"],
    ] as const) {
      expect(f, t).toContain(`WHEN p_type = '${t}' THEN EXISTS (`);
      expect(f, t).toContain(`public.is_org_controller(${alias}.org_id)`);
      expect(f, t).toContain(owner);
      expect(f, t).toContain(`public.can_manage_node(${alias}.acl_index, ${alias}.org_id)`);
    }
    expect(f).toMatch(/ELSE false\s*\n\s*END;/);
    expect(M).toContain("REVOKE ALL ON FUNCTION public.audit_row_node_manageable(text, text) FROM PUBLIC;");
    expect(M).toContain("GRANT EXECUTE ON FUNCTION public.audit_row_node_manageable(text, text) TO anon, authenticated, service_role;");
  });

  it("no SECURITY DEFINER anywhere in the file (DRLS-16 has nothing to pin; the definer census needs no row)", () => {
    expect(code(M)).not.toMatch(/SECURITY\s+DEFINER/i);
  });
});

describe("EVID-6 — the audit dead-letter outbox table", () => {
  const c = code(M);
  it("is created with the drain's state and a source CHECK, RLS on, no policy, nothing for anon / authenticated", () => {
    const t = between(c, "CREATE TABLE IF NOT EXISTS public.audit_dead_letters (", "\n);");
    for (const col of ["org_id         uuid NOT NULL", "action         text NOT NULL", "entry          jsonb NOT NULL", "source         text NOT NULL CHECK (source IN ('browser', 'server'))", "reported_by    uuid", "drain_attempts integer NOT NULL DEFAULT 0", "drained_at     timestamptz", "audit_log_id   uuid"]) {
      expect(t, col).toContain(col);
    }
    expect(c).toContain("ALTER TABLE public.audit_dead_letters ENABLE ROW LEVEL SECURITY;");
    expect(c).not.toMatch(/CREATE POLICY\s+\w+\s+ON\s+(public\.)?audit_dead_letters/i);
    expect(c).toContain("REVOKE ALL ON public.audit_dead_letters FROM PUBLIC, anon, authenticated;");
    // fix pass: DELETE too — the drain prunes rows drained 30 days ago
    expect(c).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON public.audit_dead_letters TO service_role;");
    expect(c).toContain("has_table_privilege('service_role', 'public.audit_dead_letters', 'DELETE')");
    // no foreign key: the restore / FK census needs no new edge
    expect(t).not.toMatch(/REFERENCES/i);
  });
});

describe("DEC-30 — one paste, counts-only inventory first, one result set", () => {
  const c = code(M);
  it("the inventory is a TEMP table of aggregate counts, built before BEGIN", () => {
    const inv = between(c, "CREATE TEMP TABLE _ao_g219_before AS", "BEGIN;");
    expect(c.indexOf("CREATE TEMP TABLE _ao_g219_before")).toBeLessThan(c.indexOf("BEGIN;"));
    expect(inv).not.toMatch(/SELECT \*/);
    for (const line of inv.split("UNION ALL")) expect(line).toMatch(/COUNT\(\*\)::text|::int::text/);
  });

  it("one BEGIN, one COMMIT, and ONE final SELECT after it with the (check, ok, n) shape", () => {
    expect(c.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(c.match(/^COMMIT;$/gm)?.length).toBe(1);
    const tail = c.slice(c.indexOf("COMMIT;") + "COMMIT;".length);
    // string literals blanked first: a probe's label may carry a semicolon
    const statements = tail.replace(/'(?:[^']|'')*'/g, "''").split(";").map((s) => s.trim()).filter(Boolean);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^SELECT '' AS check,/);
    expect(tail).toMatch(/AS ok,\s*\n\s*NULL::text AS n/);
    expect(tail).toContain("UNION ALL SELECT inventory, NULL, n FROM _ao_g219_before");
  });

  it("the probes read the deparsed qual with LIKE patterns that carry no bare cast, and the self-test calls the function as the paste runs it", () => {
    const tail = c.slice(c.indexOf("COMMIT;"));
    for (const m of tail.matchAll(/qual LIKE '([^']|'')*'/g)) expect(m[0]).not.toMatch(/::/);
    expect(tail).toContain("public.audit_row_node_manageable('library', 'not-a-uuid') IS FALSE");
  });

  it("the header states the paste order: after 20261142, before the P13 deploy as a HARD gate, and AGAIN after a later 20261157 paste in the same window", () => {
    expect(M).toMatch(/AFTER 20261142 \(the file stops otherwise\)/);
    expect(M).toMatch(/BEFORE the admin-and-org P13 deploy — a HARD GATE, not a\s*\n--\s+recommendation/);
    expect(M).not.toMatch(/\(recommended/);
    expect(M).toMatch(/PASTE THIS FILE AGAIN right\s*\n--\s+after 20261157, IN THE SAME SQL-EDITOR WINDOW/);
  });

  it("integrator fix pass: the header states this file goes AFTER 20261157 (20261157 first in one session; again after any later 20261157 / 20261142 paste) and either order with 20261201", () => {
    expect(M).toMatch(/AFTER 20261157, whenever 20261157 is pasted/);
    expect(M).toMatch(/paste 20261157 FIRST and this\s*\n--\s+file AFTER it; never this file and then 20261157\./);
    expect(M).toMatch(/any later re-paste of 20261142 or\s*\n--\s+20261157: each re-creates the overlay without this clause, so this\s*\n--\s+file is pasted AGAIN right after it\./);
    expect(M).toMatch(/Either order with 20261201/);
  });
});
