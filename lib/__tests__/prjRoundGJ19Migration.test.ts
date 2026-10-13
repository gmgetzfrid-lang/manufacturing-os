// projects Round G — J19 PROJECTS REMAINDERS: 20261198, two database rails.
//   §1 projects-tab SEC-21 residual 3 — a milestone's project moves only with
//      the schedule authority of every project the move touches.
//   §2 projects-tab MON-14 — a contractor is not deleted from under its quotes.
// The shape of the one paste (DEC-30), the grants (DRLS-16), the functions it
// calls left at their NEWEST definitions (found by scanning the sequence at
// test time), and every probe's fragment present verbatim in the body it
// probes. The behaviour was run on a scratch PostgreSQL 16 (the records name
// the cases and their answers).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const migDir = join(root, "supabase", "migrations");
const FILE = "20261198_prj_roundG_milestone_project_and_party_delete.sql";
const mig = (f: string) => readFileSync(join(migDir, f), "utf8");
const M = mig(FILE);
const code = (sql: string) => sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const C = code(M);
const numbered = () => readdirSync(migDir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const src = (rel: string) => readFileSync(join(root, rel), "utf8");

function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  expect(a, `missing: ${from}`).toBeGreaterThanOrEqual(0);
  const b = text.indexOf(to, a + from.length);
  expect(b, `missing after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b + to.length);
}
const fn = (name: string) => between(C, `CREATE OR REPLACE FUNCTION public.${name}(`, "\n$$;");
/** Files of the sequence that (re-)create a function of this name. */
const definers = (name: string) =>
  numbered().filter((f) => new RegExp(`CREATE (OR REPLACE )?FUNCTION (public\\.)?${name}\\(`).test(code(mig(f))));
/** The fragments a final-SELECT probe's `prosrc LIKE '%…%'` demands, unescaped. */
function probeFragments(probe: string): string[] {
  return Array.from(probe.matchAll(/prosrc LIKE '%((?:[^']|'')*)%'/g)).map((m) => m[1].replace(/''/g, "'"));
}

describe("the one-paste protocol (DEC-30)", () => {
  it("refuses to run before 20261179 / 20261098, then a TEMP inventory of COUNTs BEFORE the one transaction, and ONE final SELECT (check, ok, n)", () => {
    const guard = C.indexOf("Apply 20261179_prj_roundG_award_answers_for_each.sql");
    const temp = C.indexOf("CREATE TEMP TABLE prj_g_j19_inventory AS");
    const begin = C.indexOf("\nBEGIN;");
    const commit = C.indexOf("\nCOMMIT;");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(temp);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    expect(C.match(/\nBEGIN;/g)).toHaveLength(1);
    expect(C.match(/\nCOMMIT;/g)).toHaveLength(1);
    const g = between(C, "DO $$", "END $$;");
    expect(g).toContain("to_regprocedure('public.cost_doc_companies_barred(uuid,uuid,uuid,text)') IS NULL");
    expect(g).toContain("to_regprocedure('public.can_edit_project_schedule(uuid,uuid)') IS NULL");
    const tail = C.slice(commit);
    expect(tail).toMatch(/SELECT '(?:[^']|'')+' AS check,\s*\n\s*\([\s\S]*?\) AS ok,\s*\n\s*NULL::text AS n/);
    expect(tail.match(/;\s*$/gm)).toHaveLength(2); // "COMMIT;" and the one SELECT's end
    expect(tail).toMatch(/SELECT inventory, NULL::boolean, n FROM prj_g_j19_inventory;\s*$/);
    // counts only, never rows
    const inv = between(C, "CREATE TEMP TABLE prj_g_j19_inventory AS", "\nBEGIN;");
    const parts = inv.split(/\nUNION ALL\n/);
    expect(parts).toHaveLength(6);
    for (const sel of parts) expect(sel, sel).toMatch(/\(SELECT COUNT\((\*|DISTINCT [a-z_.]+)\) FROM [\s\S]*\)::text/);
    // set-based: no per-row registry function call in the inventory
    expect(inv).not.toMatch(/cost_doc_compan(y|ies)_barred\(/);
  });

  it("the inventory says what it does not cover: row 2's already-moved rows are SEC-24's, row 5 is a lower bound of limb (b)", () => {
    const inv = between(C, "CREATE TEMP TABLE prj_g_j19_inventory AS", "\nBEGIN;");
    const parts = inv.split(/\nUNION ALL\n/);
    expect(parts[1]).toContain("restoring the moved ones is projects-tab SEC-24");
    expect(parts[4]).toContain("registry-linked flagged contractors");
    expect(parts[4]).toContain("a LOWER BOUND: contractors whose quote answers for a flagged company by vendor name or a do-not-use look-alike are refused too and not counted here");
    expect(M).toContain("Restoring them is projects-tab\n-- SEC-24 (owner projects-joint).");
  });

  it("is not a widening: nothing is granted; HOW TO APPLY, PASTE ORDER and DEPLOY ORDER are stated", () => {
    expect(C).not.toMatch(/\bGRANT\b/);
    expect(M).toContain("NOT a widening: both sections refuse writes RLS allowed and grant nothing.");
    expect(M).toContain("-- PASTE ORDER: after 20261179");
    expect(M).toContain("-- DEPLOY ORDER: either.");
    expect(M).toContain("the importer's per-row fallback then updates each\n-- row WITHOUT the scope columns");
  });

  it("is named in the package's reserved number, and the sequence holds no other 20261198", () => {
    expect(numbered().filter((f) => f.startsWith("20261198"))).toEqual([FILE]);
    expect(FILE).toMatch(/^20261198_prj_roundG_[a-z_]+\.sql$/);
  });

  it("re-creates no existing function: both trigger functions are new, and what they call keeps its NEWEST definition elsewhere", () => {
    expect(definers("enforce_milestone_project_move")).toEqual([FILE]);
    expect(definers("enforce_project_party_delete")).toEqual([FILE]);
    const edit = definers("can_edit_project_schedule");
    expect(edit[edit.length - 1]).toBe("20261098_prj_roundG_apply_milestone_moves.sql");
    const barred = definers("cost_doc_companies_barred");
    expect(barred[barred.length - 1]).toBe("20261179_prj_roundG_award_answers_for_each.sql");
    // no trigger of the same name anywhere else
    for (const t of ["trg_milestones_project_move", "trg_project_parties_delete_guard"]) {
      expect(numbered().filter((f) => f !== FILE && mig(f).includes(t))).toEqual([]);
    }
  });
});

describe("DRLS-16: both trigger functions", () => {
  for (const name of ["enforce_milestone_project_move", "enforce_project_party_delete"]) {
    it(`${name}: SECURITY DEFINER, search_path pinned, EXECUTE revoked from PUBLIC, anon and authenticated`, () => {
      expect(fn(name)).toMatch(/RETURNS trigger\s*\nLANGUAGE plpgsql\s*\nSECURITY DEFINER\s*\nSET search_path = public\s*\nAS \$\$/);
      for (const r of ["PUBLIC", "anon", "authenticated"]) expect(C).toContain(`REVOKE ALL ON FUNCTION public.${name}() FROM ${r};`);
    });
  }
});

describe("§1 SEC-21 residual 3 — milestones.project_id", () => {
  it("fires BEFORE UPDATE OF project_id, per row, only when the value changes", () => {
    expect(C).toMatch(/CREATE TRIGGER trg_milestones_project_move\s*\n\s*BEFORE UPDATE OF project_id ON milestones\s*\n\s*FOR EACH ROW\s*\n\s*WHEN \(OLD\.project_id IS DISTINCT FROM NEW\.project_id\)\s*\n\s*EXECUTE FUNCTION public\.enforce_milestone_project_move\(\);/);
  });

  it("passes, in order: no change; the service role; the project's own delete (project row gone); the purge — then refuses another org's project, then any move onto or off a PRIVATE project (its history keeps its old reach), then asks the schedule authority of the OLD and the NEW project", () => {
    const body = fn("enforce_milestone_project_move");
    const at = (s: string) => { const i = body.indexOf(s); expect(i, s).toBeGreaterThan(0); return i; };
    const order = [
      "IF NEW.project_id IS NOT DISTINCT FROM OLD.project_id THEN RETURN NEW; END IF;",
      "IF auth.uid() IS NULL THEN RETURN NEW; END IF;",
      "AND NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = OLD.project_id) THEN",
      "AND COALESCE(current_setting('app.record_purge', true), '') = 'project:' || OLD.project_id::text THEN",
      "AND NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = NEW.project_id AND p.org_id = NEW.org_id) THEN",
      "WHERE p.id IN (OLD.project_id, NEW.project_id) AND p.visibility IS NOT DISTINCT FROM 'private') THEN",
      "IF (OLD.project_id IS NOT NULL AND NOT public.can_edit_project_schedule(OLD.org_id, OLD.project_id))",
      "OR (NEW.project_id IS NOT NULL AND NOT public.can_edit_project_schedule(NEW.org_id, NEW.project_id)) THEN",
    ].map(at);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // the project's-own-delete pass is only for a move OFF to NULL
    expect(body).toContain("IF NEW.project_id IS NULL AND OLD.project_id IS NOT NULL\n     AND NOT EXISTS");
    expect((body.match(/USING ERRCODE = 'insufficient_privilege';/g) ?? []).length).toBe(3);
  });

  it("the authority it asks is 20261098's can_edit_project_schedule — the predicate apply_milestone_moves and the baseline RPCs enforce", () => {
    const def = mig("20261098_prj_roundG_apply_milestone_moves.sql");
    expect(def).toContain("SELECT caller_holds_any_role(p_org, ARRAY['Admin','DocCtrl','Manager','Supervisor']::text[])\n      OR EXISTS (SELECT 1 FROM projects p WHERE p.id = p_project AND p.org_id = p_org AND p.owner_user_id = auth.uid());");
    expect(mig("20261099_prj_roundG_baseline_authority.sql")).toContain("IF NOT can_edit_project_schedule(p_org, p_project) THEN");
  });

  it("the app half: a re-import writes each matched row's OWN project; no app path patches project_id", () => {
    const lib = src("lib/milestones.ts");
    expect(lib).toContain('const EXISTING_READ_BASE = ["id", "project_id", "external_ref",');
    expect(lib).toContain("id: p.id!, ...scope, project_id: p.existing!.project_id ?? null, external_ref: p.row.externalRef ?? null,");
    // the per-row fallback writes no scope column (so the app before J19 still lands rows under the rail)
    expect(lib).toContain(': await supabase.from("milestones").update(updateFields(p)).eq("id", p.id!).select("id").maybeSingle();');
    const updateFieldsBody = between(lib, "const updateFields = (p: Prepared) => stripForSchema({", "});");
    expect(updateFieldsBody).not.toMatch(/project_id|\.\.\.scope/);
    const patch = between(lib, "const PATCH_COLUMN", "};");
    expect(patch).not.toContain("project_id");
  });
});

describe("§2 MON-14 — project_parties delete", () => {
  it("fires BEFORE DELETE, per row", () => {
    expect(C).toMatch(/CREATE TRIGGER trg_project_parties_delete_guard\s*\n\s*BEFORE DELETE ON project_parties\s*\n\s*FOR EACH ROW EXECUTE FUNCTION public\.enforce_project_party_delete\(\);/);
  });

  it("passes, in order: the service role; the project's or org's own delete; the purge — then refuses an open quote's contractor, then judges every quote by the list before and after its party_id is nulled", () => {
    const body = fn("enforce_project_party_delete");
    const at = (s: string) => { const i = body.indexOf(s); expect(i, s).toBeGreaterThan(0); return i; };
    const order = [
      "IF auth.uid() IS NULL THEN RETURN OLD; END IF;",
      "IF NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = OLD.project_id)",
      "OR NOT EXISTS (SELECT 1 FROM public.orgs o WHERE o.id = OLD.org_id) THEN",
      "IF COALESCE(current_setting('app.record_purge', true), '') = 'project:' || OLD.project_id::text THEN RETURN OLD; END IF;",
      "WHERE d.party_id = OLD.id AND d.kind = 'quote' AND d.status IN ('draft', 'parsed');",
      "IF v_open > 0 THEN",
      "WHERE d.party_id = OLD.id AND d.kind = 'quote'\n  LOOP",
      "v_before := cost_doc_companies_barred(v_doc.org_id, v_doc.company_id, OLD.id, v_doc.vendor_name);",
      "CONTINUE WHEN jsonb_array_length(v_before) = 0;",
      "v_after := cost_doc_companies_barred(v_doc.org_id, v_doc.company_id, NULL, v_doc.vendor_name);",
      "WHERE NOT v_after @> jsonb_build_array(jsonb_build_object('id', e -> 'id'))",
      "RETURN OLD;\nEND;",
    ].map(at);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect((body.match(/USING ERRCODE = 'check_violation';/g) ?? []).length).toBe(2);
    // company_id is 20261096's column: read through to_jsonb, as 20261179 §3 does
    expect(body).toContain("NULLIF(to_jsonb(d) ->> 'company_id', '')::uuid AS company_id");
    expect(body).not.toMatch(/\bd\.company_id\b/);
  });

  it("its before/after test is 20261179 §3's own (the same left-company query, the same flag wording)", () => {
    const rail = between(code(mig("20261179_prj_roundG_award_answers_for_each.sql")), "CREATE OR REPLACE FUNCTION public.enforce_cost_document_company_move(", "\n$$;");
    const body = fn("enforce_project_party_delete");
    for (const line of [
      "      FROM jsonb_array_elements(v_before) e",
      "     WHERE NOT v_after @> jsonb_build_array(jsonb_build_object('id', e -> 'id'))",
      "     LIMIT 1;",
    ]) {
      expect(rail).toContain(line.slice(2)); // the rail's lines, one loop level shallower
      expect(body).toContain(line);
    }
    expect(rail).toContain("CASE v_left ->> 'status' WHEN 'do_not_use' THEN 'DO NOT USE' ELSE 'inactive' END");
    expect(body).toContain("CASE v_left ->> 'status' WHEN 'do_not_use' THEN 'DO NOT USE' ELSE 'inactive' END");
  });

  it("the open statuses are the CHECK set's open pair (20261093), and the purge deletes the quotes before the contractors (20261103)", () => {
    expect(mig("20261093_prj_roundG_money_rails.sql")).toContain("status NOT IN ('draft', 'parsed', 'awarded', 'declined', 'posted', 'void')");
    const purge = mig("20261103_prj_roundG_project_closeout_rails.sql");
    expect(purge.indexOf("DELETE FROM cost_documents WHERE project_id = p_project;")).toBeLessThan(purge.indexOf("DELETE FROM project_parties WHERE project_id = p_project;"));
    expect(purge).toContain("PERFORM set_config('app.record_purge', 'project:' || p_project::text, true);");
  });

  it("no app path deletes a contractor (the rail breaks no flow)", () => {
    const files = ["lib/costs.ts", "lib/projects.ts", "lib/turnover.ts", "components/projects/cost/QuotesPanel.tsx", "lib/projectWizardWrites.ts"];
    for (const f of files) expect(src(f), f).not.toMatch(/from\("project_parties"\)[^;]*\.delete\(/);
  });
});

describe("the final SELECT's probes", () => {
  it("every prosrc fragment a probe demands is in the body it probes; trigger probes match the CREATE TRIGGER lines; DRLS-16 probes for both", () => {
    const tail = C.slice(C.indexOf("\nCOMMIT;"));
    const probes = tail.split(/\nUNION ALL\n/);
    const forFn = (name: string) => probes.find((p) => p.includes(`proname = '${name}'`))!;
    for (const name of ["enforce_milestone_project_move", "enforce_project_party_delete"]) {
      const p = forFn(name);
      expect(p, name).toContain("prosecdef AND proconfig::text LIKE '%search_path=public%'");
      const frags = probeFragments(p);
      expect(frags.length).toBeGreaterThanOrEqual(5);
      for (const f of frags) expect(fn(name), f).toContain(f);
      expect(tail).toContain(`NOT has_function_privilege('anon', 'public.${name}()', 'EXECUTE')`);
      expect(tail).toContain(`NOT has_function_privilege('authenticated', 'public.${name}()', 'EXECUTE')`);
    }
    expect(tail).toContain("LIKE '%BEFORE UPDATE OF project_id ON public.milestones FOR EACH ROW WHEN ((old.project_id IS DISTINCT FROM new.project_id))%'");
    expect(tail).toContain("LIKE '%BEFORE DELETE ON public.project_parties FOR EACH ROW%'");
    expect(probes.filter((p) => p.includes("NULL::text")).length).toBe(6);
  });
});
