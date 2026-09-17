// Round E — package C-ownership migration shape tests: 20261059 (OWN-18 org
// arms on user_can_publish_on_library), 20261060 (OWN-19 archive takes
// publish authority) and 20261061 (OWN-21 / DEC-11 branch resolution
// authority). Re-created bodies are line-diffed against the LIVE 20261046
// bodies so nothing else moves; the single-paste shape and probe hygiene are
// pinned for all three.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(process.cwd(), "supabase/migrations", f), "utf8");
const m46 = read("20261046_rp_phase6_sweep_authority_by_collection.sql");
const m59 = read("20261059_rp_roundE_org_subject_publish.sql");
const m60 = read("20261060_rp_roundE_archive_publish_authority.sql");
const m61 = read("20261061_rp_roundE_branch_resolution_authority.sql");

function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from); if (a < 0) throw new Error(`anchor not found: ${from}`);
  const b = text.indexOf(to, a + from.length); if (b < 0) throw new Error(`end not found after ${from}: ${to}`);
  return text.slice(a, b);
}
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}
const nonBlank = (ls: string[]) => ls.filter((l) => l.trim() !== "").map((l) => l.trim());

describe("single-paste shape (Round E protocol) and probe hygiene", () => {
  it("BEGIN … COMMIT, then ONE final SELECT (check, ok, n) unioning probes and inventory", () => {
    for (const [name, m] of [["59", m59], ["60", m60], ["61", m61]] as const) {
      expect(m.indexOf("BEGIN;"), name).toBeGreaterThan(0);
      expect(m.indexOf("COMMIT;"), name).toBeGreaterThan(m.indexOf("BEGIN;"));
      const after = m.slice(m.indexOf("COMMIT;") + 7);
      // exactly one statement after COMMIT — the final SELECT
      expect(after.replace(/--[^\n]*/g, "").trim().split(";").filter((s) => s.trim()).length, name).toBe(1);
      expect(after, name).toMatch(/SELECT '[^']+' AS check,\s*\n\s*\(SELECT [\s\S]+?\) AS ok,\s*\n\s*NULL::text AS n/);
      expect(after, name).toMatch(/UNION ALL\s*\nSELECT 'inventory[^']*', NULL::boolean, /);
    }
  });
  it("the two widening migrations capture their inventory into a TEMP TABLE before BEGIN and print it", () => {
    for (const [name, m, t] of [["59", m59, "_rp_e59_before"], ["60", m60, "_rp_e60_before"]] as const) {
      expect(m.indexOf(`CREATE TEMP TABLE IF NOT EXISTS ${t} AS`), name).toBeGreaterThan(0);
      expect(m.indexOf(`CREATE TEMP TABLE IF NOT EXISTS ${t} AS`), name).toBeLessThan(m.indexOf("BEGIN;"));
      expect(m, name).toMatch(new RegExp(`SELECT 'inventory \\(before apply\\): ' \\|\\| what, NULL::boolean, n::text FROM ${t}`));
      // aggregate only — never a customer row
      const inv = between(m, `CREATE TEMP TABLE IF NOT EXISTS ${t} AS`, "BEGIN;");
      for (const sel of inv.split(/UNION ALL/)) expect(sel, name).toMatch(/COUNT\(/);
    }
    // 61 narrows: no temp table needed, inventory rides the final SELECT
    expect(m61).not.toMatch(/TEMP TABLE/);
    expect(m61).toMatch(/SELECT 'inventory: open branch debts \(all orgs\)', NULL::boolean, COUNT\(\*\)::text/);
  });
  it("policy probes never carry a bare cast; prosrc probes escape intra-literal apostrophes as a pair", () => {
    for (const m of [m59, m60, m61]) {
      const v = m.slice(m.indexOf("COMMIT;"));
      for (const x of v.matchAll(/(?:qual|with_check) LIKE '((?:[^']|'')*)'/g)) {
        expect(x[1], x[1]).not.toMatch(/\w::\w/);
        expect(x[1], x[1]).not.toMatch(/\]::\w+\[\]/);
      }
      for (const x of v.matchAll(/prosrc (?:NOT )?LIKE '((?:[^']|'')*)'/g)) {
        const unescaped = x[1].replace(/''/g, "'");
        if (/[A-Za-z]'[A-Za-z]/.test(unescaped)) expect(x[1], x[1]).toMatch(/[A-Za-z]''''[A-Za-z]/);
      }
    }
  });
  it("every re-created SECURITY DEFINER function pins search_path", () => {
    for (const m of [m59, m60]) {
      const defs = m.match(/RETURNS \w+ LANGUAGE plpgsql[^\n]*SECURITY DEFINER[^\n]*/g) ?? [];
      expect(defs.length).toBeGreaterThan(0);
      for (const d of defs) expect(d).toMatch(/SET search_path = public/);
    }
  });
});

describe("20261059 — user_can_publish_on_library is the live 20261046 body plus the org arms (OWN-18)", () => {
  const live = between(m46, "CREATE OR REPLACE FUNCTION user_can_publish_on_library", "$$;");
  const next = between(m59, "CREATE OR REPLACE FUNCTION user_can_publish_on_library", "$$;");
  it("adds exactly the org lines (deny publish, deny admin, allow publish / admin-unless-denied)", () => {
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(nonBlank(onlyInA)).toEqual([
      "-- Explicit deny of publish wins (user / ANY held role / team).",
      "SELECT 1 FROM unnest(v_teams) t WHERE (v_idx->'deny'->'teams'->'admin') ? t), false);",
      "-- the user, ANY held role, or a team.",
      "OR (NOT v_admin_denied AND (v_idx->'allow'->'teams'->'admin') ? t))),",
    ]);
    expect(nonBlank(onlyInB)).toEqual([
      "-- Explicit deny of publish wins (user / ANY held role / team / org).",
      "OR COALESCE((v_idx->'deny'->'orgs'->'publish') ? p_org::text, false)",
      "SELECT 1 FROM unnest(v_teams) t WHERE (v_idx->'deny'->'teams'->'admin') ? t), false)",
      "OR COALESCE((v_idx->'deny'->'orgs'->'admin') ? p_org::text, false);",
      "-- the user, ANY held role, a team, or the org.",
      "OR (NOT v_admin_denied AND (v_idx->'allow'->'teams'->'admin') ? t)))",
      "-- OWN-18: an org-subject grant (\"everyone in the org\") — the drawer offers",
      "-- it, the raw evaluator and can_manage_node honour it; publish does too.",
      "OR (v_idx->'allow'->'orgs'->'publish') ? p_org::text",
      "OR (NOT v_admin_denied AND (v_idx->'allow'->'orgs'->'admin') ? p_org::text),",
    ]);
  });
  it("keeps the collection short-circuit, the deny-wins order and the admin-deny gate", () => {
    expect(next).toMatch(/IF v_roles && ARRAY\['Admin','DocCtrl'\]::text\[\] THEN\s*\n\s*RETURN true;/);
    expect(next.indexOf("'deny'->'orgs'->'publish'")).toBeLessThan(next.indexOf("v_admin_denied :="));
    expect(next.indexOf("v_admin_denied :=")).toBeLessThan(next.indexOf("'allow'->'orgs'->'publish'"));
    expect(next).toMatch(/SECURITY DEFINER SET search_path = public/);
  });
  it("its probes read the org arms verbatim from pg_proc", () => {
    expect(m59).toMatch(/prosrc LIKE '%\(v_idx->''allow''->''orgs''->''publish''\) \? p_org::text%'/);
    expect(m59).toMatch(/prosrc LIKE '%\(v_idx->''deny''->''orgs''->''admin''\) \? p_org::text%'/);
  });
});

describe("20261060 — enforce_document_publish_guard is the live 20261046 body plus the Archived disjunct (OWN-19)", () => {
  const live = between(m46, "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()", "$$;");
  const next = between(m60, "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()", "$$;");
  it("adds exactly the disjunct (the terminal-exit line loses its semicolon to it)", () => {
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(nonBlank(onlyInA)).toEqual([
      "OR (OLD.status IN ('Superseded', 'Archived', 'Void') AND NEW.status IS DISTINCT FROM OLD.status);",
    ]);
    expect(nonBlank(onlyInB)).toEqual([
      "OR (OLD.status IN ('Superseded', 'Archived', 'Void') AND NEW.status IS DISTINCT FROM OLD.status)",
      "-- OWN-19: archiving is a lifecycle act of the same shape as supersede —",
      "-- the publisher tier (controller / granted publisher / effective owner)",
      "-- retires a record whichever door it leaves by.",
      "OR (NEW.status = 'Archived' AND COALESCE(OLD.status, '') <> 'Archived');",
    ]);
  });
  it("verified-sound ordering survives: review gate → is_org_controller → publisher-or-owner → hold; service role passes", () => {
    expect(next).toMatch(/IF v_actor IS NULL THEN\s*\n\s*RETURN NEW;/);
    expect(next.indexOf("outstanding review sign-offs")).toBeLessThan(next.indexOf("IF is_org_controller(NEW.org_id) THEN"));
    expect(next.indexOf("IF is_org_controller(NEW.org_id) THEN")).toBeLessThan(next.indexOf("user_can_publish_on_library(NEW.library_id"));
    expect(next.indexOf("user_can_publish_on_library(NEW.library_id")).toBeLessThan(next.indexOf("Document has an active hold"));
    expect(m60).toMatch(/prosrc LIKE '%\(NEW\.status = ''Archived'' AND COALESCE\(OLD\.status, ''''\) <> ''Archived''\)%'/);
  });
});

describe("20261061 — revision_branches_org_update takes a controller or the effective owner (OWN-21 / DEC-11)", () => {
  it("keeps the membership arm and ANDs the authority arms; SELECT / INSERT are not touched", () => {
    const pol = between(m61, "CREATE POLICY revision_branches_org_update ON revision_branches FOR UPDATE USING (", "COMMIT;");
    expect(pol).toMatch(/org_members\.uid = auth\.uid\(\) AND org_members\.status = 'active'\)\s*\n\s*AND \(/);
    expect(pol).toMatch(/is_org_controller\(org_id\)\s*\n\s*OR EXISTS \(SELECT 1 FROM documents d\s*\n\s*WHERE d\.id = revision_branches\.document_id\s*\n\s*AND user_is_effective_owner\(d\.owner_user_id, d\.collection_id, d\.library_id, auth\.uid\(\)\)\)/);
    expect(m61).toMatch(/DROP POLICY IF EXISTS revision_branches_org_update ON revision_branches;/);
    expect(m61).not.toMatch(/revision_branches_org_select ON revision_branches FOR/);
    expect(m61).not.toMatch(/revision_branches_org_insert ON revision_branches FOR/);
    // the probe reads the deparsed qual — no casts
    expect(m61).toMatch(/qual LIKE '%user_is_effective_owner\(d\.owner_user_id, d\.collection_id, d\.library_id, auth\.uid\(\)\)%'/);
  });
});
