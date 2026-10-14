// projects Round G — J20: projects-tab SEC-24, the milestones a pre-J19
// document-only re-import moved off their project. The shape of 20261215
// (counts first, an operator-confirmed and audited put-back) and the reading
// it rests on: no screen of the app ever ran a document-only import, so the
// population is empty on a database the app alone wrote — the inventory says
// whether this one holds any. Scratch PostgreSQL 16 (whole sequence): S0–S12
// on SEC-24.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const migDir = join(root, "supabase", "migrations");
const FILE = "20261215_prj_roundG_stranded_milestones.sql";
const M = readFileSync(join(migDir, FILE), "utf8");
const code = (sql: string) => sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const C = code(M);
const numbered = () => readdirSync(migDir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  expect(a, `missing: ${from}`).toBeGreaterThanOrEqual(0);
  const b = text.indexOf(to, a + from.length);
  expect(b, `missing after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b + to.length);
}
const fn = () => between(M, "CREATE OR REPLACE FUNCTION public.reattach_stranded_milestones(", "\n$$;");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("SEC-24 — what the repair rests on: no screen runs a document-only schedule import", () => {
  it("the importers' only callers outside lib/milestones.ts pass a project and never a document", () => {
    const callers = [...walk(join(root, "app")), ...walk(join(root, "components")), ...walk(join(root, "lib")).filter((f) => !f.includes("__tests__"))]
      .filter((f) => !f.endsWith(join("lib", "milestones.ts")))
      .map((f) => ({ f: relative(root, f), src: readFileSync(f, "utf8") }))
      .filter(({ src }) => /\b(importMilestonesFromParsed|importGhostMilestones)\s*\(/.test(src));
    expect(callers.map((c) => c.f)).toEqual([join("components", "projects", "ScheduleImportModal.tsx")]);
    const call = between(callers[0].src, "return importMilestonesFromParsed({", "createdByName: userName,");
    expect(call).toMatch(/^return importMilestonesFromParsed\(\{\n\s*orgId, projectId,\n/);
    expect(call).not.toMatch(/documentId/);
  });
});

describe("20261215 — the one-paste protocol (DEC-30)", () => {
  it("refuses to run without 20261198, then a TEMP inventory of COUNTs BEFORE the one transaction, and ONE final SELECT (check, ok, n)", () => {
    expect(between(M, "DO $$", "$$;")).toContain("to_regprocedure('public.enforce_milestone_project_move()') IS NULL");
    const inv = between(M, "CREATE TEMP TABLE prj_g_j20_stranded_inventory AS", "\nBEGIN;");
    expect(M.indexOf("DO $$")).toBeLessThan(M.indexOf("CREATE TEMP TABLE"));
    for (const sel of inv.split(/UNION ALL/)) expect(sel, sel).toMatch(/COUNT\(\*\)/);
    expect(inv).toMatch(/\)::text AS n/);
    expect(M.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(M.match(/^COMMIT;$/gm)).toHaveLength(1);
    const tail = code(M.slice(M.indexOf("\nCOMMIT;") + "\nCOMMIT;".length));
    expect(tail.split("\n").filter((l) => /^(BEGIN|COMMIT|CREATE|ALTER|GRANT|REVOKE|DROP|INSERT|UPDATE|DELETE|DO)\b/.test(l))).toEqual([]);
    expect(tail.trim().endsWith("SELECT inventory, NULL::boolean, n FROM prj_g_j20_stranded_inventory;")).toBe(true);
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,\s*\n\s*NULL::text AS n/);
    // counts only — never a customer row
    expect(inv).not.toMatch(/SELECT\s+(m\.)?(name|external_ref|id)\b/i);
  });
  it("is the package's second reserved number, and nothing else is 20261215", () => {
    expect(numbered().filter((f) => f.startsWith("20261215"))).toEqual([FILE]);
  });
  it("the first inventory row is 20261198's row 2, the candidates, read the same way", () => {
    const j19 = readFileSync(join(migDir, "20261198_prj_roundG_milestone_project_and_party_delete.sql"), "utf8");
    const where = "WHERE project_id IS NULL AND document_id IS NOT NULL AND external_ref IS NOT NULL";
    expect(j19).toContain(where);
    expect(between(M, "CREATE TEMP TABLE", "UNION ALL")).toContain(where);
  });
});

describe("20261215 — reattach_stranded_milestones: counts first, an operator-confirmed and audited put-back", () => {
  it("SECURITY DEFINER, search_path pinned; EXECUTE revoked from PUBLIC and anon, granted to authenticated and the service role only (DRLS-16)", () => {
    expect(fn()).toMatch(/\nRETURNS jsonb\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = public\nAS \$\$/);
    expect(C).toContain("REVOKE ALL ON FUNCTION public.reattach_stranded_milestones(uuid, uuid, uuid, text, integer) FROM PUBLIC, anon;");
    expect(C).toContain("GRANT EXECUTE ON FUNCTION public.reattach_stranded_milestones(uuid, uuid, uuid, text, integer) TO authenticated, service_role;");
    expect(C.match(/GRANT EXECUTE/g)).toHaveLength(1);
  });
  it("who: a signed-in caller must be an org controller; the SQL editor / service role is the operator", () => {
    expect(fn()).toMatch(/BEGIN\s*\n\s*IF v_uid IS NOT NULL AND NOT is_org_controller\(p_org\) THEN\s*\n\s*RAISE EXCEPTION 'Putting tasks back on a project needs Admin or Document Control; nothing was changed\. \(SEC-24, 20261215\)'/);
  });
  it("the candidates are the org's milestones of that document and source on NO project with a reference — locked, then counted", () => {
    const f = fn();
    const cand = "m.org_id = p_org AND m.project_id IS NULL AND m.document_id = p_document AND m.source = p_source AND m.external_ref IS NOT NULL";
    expect(f.split(cand).length - 1).toBeGreaterThanOrEqual(5);
    expect(f.indexOf("FOR UPDATE;")).toBeLessThan(f.indexOf("SELECT COUNT(*) INTO v_n"));
  });
  it("counts first: expected NULL answers the counts and the evidence and writes nothing", () => {
    const f = fn();
    const dry = between(f, "IF p_expected IS NULL THEN", "END IF;");
    expect(dry).toContain("RETURN jsonb_build_object('applied', false, 'candidates', v_n, 'stampedOnProject', v_stamped,");
    expect(dry).toContain("'siblingsOnProject', v_siblings, 'collisions', v_collisions, 'privateProject', v_private);");
    // nothing is written before the dry run returns
    expect(f.slice(0, f.indexOf("IF p_expected IS NULL THEN"))).not.toMatch(/\b(UPDATE milestones|INSERT INTO)\b/);
    // the evidence: 20261157 section 9's own stamp for THAT project; the rest of the schedule still on it
    expect(f).toContain("AND a.details->>'projectIdFrom' = 'milestone'");
    expect(f).toContain("AND a.details->>'projectId' = p_project::text);");
    expect(f).toContain("WHERE s.org_id = p_org AND s.project_id = p_project AND s.document_id = p_document AND s.source = p_source;");
  });
  it("apply: the confirmed count must equal the count under lock; a collision with the project's references and a signed-in move onto a private project are refused; nothing is moved before those checks", () => {
    const f = fn();
    const order = ["IF p_expected IS DISTINCT FROM v_n THEN", "IF v_collisions > 0 THEN", "IF v_private AND v_uid IS NOT NULL THEN", "UPDATE milestones SET project_id = p_project"]
      .map((s) => { const i = f.indexOf(s); expect(i, s).toBeGreaterThan(0); return i; });
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("one MILESTONE_REATTACHED audit row per milestone moved, typed project on the project, naming the milestone, document, source, reference and both ends", () => {
    const loop = between(fn(), "FOR r IN SELECT m.id, m.name, m.external_ref FROM milestones m", "END LOOP;");
    expect(loop).toContain("UPDATE milestones SET project_id = p_project, updated_at = NOW(), updated_by = v_uid WHERE id = r.id;");
    expect(loop).toContain("VALUES ('MILESTONE_REATTACHED', 'project', p_project::text, p_org, v_uid,");
    for (const k of ["'milestoneId', r.id", "'documentId', p_document", "'source', p_source", "'externalRef', r.external_ref", "'fromProjectId', NULL", "'toProjectId', p_project", "'repair', 'SEC-24'"]) {
      expect(loop, k).toContain(k);
    }
  });
  it("20261198's rail is left as it is (not re-created): a signed-in put-back is still judged by it", () => {
    expect(C).not.toMatch(/enforce_milestone_project_move\(\)\s*RETURNS|CREATE TRIGGER|DROP TRIGGER/);
  });
});
