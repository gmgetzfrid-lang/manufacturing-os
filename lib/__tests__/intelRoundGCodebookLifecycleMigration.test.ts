// intelligence Round G (I-16 CODEBOOK LIFECYCLE) —
// 20261178_intel_roundG_codebook_lifecycle.sql, read as text. There is no
// live database here: the paste's final SELECT is the live check, and the
// file was run on a scratch PostgreSQL 16 (the cases are recorded on CB-5:
// the rename's atomicity under an injected failure, both guards, the
// version stamps, the legend rule, a re-paste).
//
// Shape:
//   * DEC-30 one paste: a TEMP-table inventory of aggregate counts BEFORE the
//     transaction, one BEGIN / COMMIT, ONE final SELECT of (check, ok, n);
//   * the two re-created functions start from their NEWEST earlier
//     definition, found by scanning the sequence, and differ by exactly the
//     added lines (an exact cut gives the base back byte for byte);
//   * the rename's setting app.codebook_rename is SET by this file only, and
//     only around the rename's own writes (transaction-local, cleared right
//     after the old row's delete); it names the kind, so a type rename never
//     moves a flow end, and it makes a rename ONE new codebook version;
//   * a rename whose rewritten head would read as another unit and type is
//     refused (named by the dry run first);
//   * rename_codebook_code: SECURITY DEFINER, search_path pinned, refuses a
//     NULL uid, anyone outside is_org_controller and a controller who also
//     holds Viewer / Auditor (20261045's deny-if-any) before it writes,
//     EXECUTE for authenticated only (DRLS-16), the order of its steps;
//   * 20261128's in-use guard is not touched; every prosrc probe names text
//     that is in the body it checks.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "supabase", "migrations");
const FILE = "20261178_intel_roundG_codebook_lifecycle.sql";
const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const text = (f: string) => readFileSync(join(dir, f), "utf8");
const m = text(FILE);
const strip = (s: string) => s.replace(/--[^\n]*/g, "");
const lineDiff = (a: string, b: string) => {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
};
/** `CREATE OR REPLACE FUNCTION name(…) … $$;` in a source, or null. */
const fnIn = (src: string, name: string): string | null => {
  const at = src.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  if (at < 0) return null;
  return src.slice(at, src.indexOf("$$;", src.indexOf("$$", at) + 2) + 3);
};
/** The newest migration BEFORE this one that defines the function. */
const newestEarlier = (name: string): { file: string; body: string } => {
  let out: { file: string; body: string } | null = null;
  for (const f of files) {
    if (f >= FILE) break;
    const body = fnIn(text(f), name);
    if (body) out = { file: f, body };
  }
  if (!out) throw new Error(`no earlier definition of ${name}`);
  return out;
};
const body = (name: string) => {
  const b = fnIn(m, name);
  if (!b) throw new Error(`${name} is not defined in ${FILE}`);
  return b;
};

describe("DEC-30 — one paste: inventory before the transaction, one BEGIN / COMMIT, one final result set", () => {
  const code = strip(m);
  it("the TEMP-table inventory is captured BEFORE BEGIN, aggregate counts only (no customer rows)", () => {
    const inv = code.slice(code.indexOf("CREATE TEMP TABLE _intel_g78_before"), code.indexOf("\nBEGIN;"));
    expect(code.indexOf("CREATE TEMP TABLE _intel_g78_before")).toBeGreaterThan(0);
    expect(code.indexOf("CREATE TEMP TABLE _intel_g78_before")).toBeLessThan(code.indexOf("\nBEGIN;"));
    expect(code).toContain("DROP TABLE IF EXISTS pg_temp._intel_g78_before;");
    const selects = inv.split(/\nUNION ALL\n/);
    expect(selects.length).toBe(11);
    for (const s of selects) expect(s, s.slice(0, 80)).toMatch(/COUNT\(\*\)/);
  });
  it("one BEGIN, one COMMIT, and exactly one statement after it: the SELECT of (check, ok, n)", () => {
    expect(code.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(code.match(/^COMMIT;$/gm)).toHaveLength(1);
    const tail = code.slice(code.indexOf("\nCOMMIT;\n") + "\nCOMMIT;\n".length);
    // string literals (check labels, prosrc patterns) carry semicolons of their own
    expect(tail.replace(/'(?:[^']|'')*'/g, "''").split(";").filter((s) => s.trim()).length).toBe(1);
    expect(tail).toMatch(/^\s*SELECT '[^']+' AS "check",/);
    expect(tail).toContain(" AS ok,\n       NULL::text AS n");
    expect(tail).toContain("SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g78_before");
  });
  it("the header states what it changes, how the rename passes both guards, the paste / deploy order, and the app before the paste", () => {
    const header = m.slice(0, m.indexOf("DROP TABLE IF EXISTS pg_temp._intel_g78_before"));
    expect(header).toContain("HOW THE RENAME PASSES THE TWO GUARDS, NEITHER WEAKENED.");
    expect(header).toContain("PASTE / DEPLOY ORDER: either.");
    expect(header).toContain("(PGRST202 / 42883)");
    expect(header).toContain("42703");
    expect(header).toContain("WIDENS: the controller tier gains renaming a code in place (counted");
  });
});

describe("process_flows_guard — re-created from its newest definition plus ONE block", () => {
  const base = newestEarlier("process_flows_guard");
  const next = body("process_flows_guard");
  const BLOCK_START = "  -- CB-5 (20261178): the Site Codebook's own rename moves a unit end from";
  const block = next.slice(next.indexOf(BLOCK_START), next.indexOf("  -- UPDATE by a person. What a flow is, and where it was read, are fixed."));
  it("the newest earlier definer is 20261155 (found by scan, so a later re-creation folded in at merge is the base)", () => {
    expect(base.file).toBe("20261155_intel_roundG_process_flows_authority.sql");
  });
  it("an exact cut: the body minus the variable and the block IS 20261155's, byte for byte; nothing removed", () => {
    expect(next.replace("  v_rename     text;\n", "").replace(block, "")).toBe(base.body);
    expect(lineDiff(base.body, next).onlyInA).toEqual([]);
  });
  it("the block sits after the INSERT arm and the endpoint check, before every person rule of an UPDATE", () => {
    const at = next.indexOf(BLOCK_START);
    expect(at).toBeGreaterThan(next.indexOf("process_flows_endpoint"));
    expect(at).toBeGreaterThan(next.indexOf("IF v_uid IS NULL THEN RETURN NEW; END IF;"));
    expect(at).toBeGreaterThan(next.indexOf("IF TG_OP = 'INSERT' THEN"));
    expect(at).toBeLessThan(next.indexOf("process_flows_fixed"));
    expect(at).toBeLessThan(next.indexOf("process_flows_decide"));
  });
  it("it admits only: the setting naming THIS org and a UNIT rename, the controller tier, nothing but a unit end's ref moving from the old code to the new", () => {
    expect(block).toContain("v_rename := NULLIF(current_setting('app.codebook_rename', true), '');");
    expect(block).toContain("AND (v_rename::jsonb ->> 'org') = NEW.org_id::text");
    expect(block).toContain("AND (v_rename::jsonb ->> 'kind') = 'unit'");
    expect(block).toContain("AND is_org_controller(NEW.org_id)");
    expect(block).toContain("AND (to_jsonb(NEW) - 'from_ref' - 'to_ref') = (to_jsonb(OLD) - 'from_ref' - 'to_ref')");
    expect(block).toContain("OR (NEW.from_kind = 'unit' AND OLD.from_ref = (v_rename::jsonb ->> 'old') AND NEW.from_ref = (v_rename::jsonb ->> 'new')))");
    expect(block).toContain("OR (NEW.to_kind = 'unit' AND OLD.to_ref = (v_rename::jsonb ->> 'old') AND NEW.to_ref = (v_rename::jsonb ->> 'new'))) THEN");
    expect(strip(block).match(/RETURN NEW;/g)).toHaveLength(1);
    expect(block).not.toMatch(/'Admin'|'DocCtrl'/); // the tier is is_org_controller's (DEC-35)
  });
  it("still invoker rights, search_path pinned; the trigger is not re-created (CREATE OR REPLACE keeps it bound)", () => {
    expect(next).toContain("RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$");
    expect(next).not.toMatch(/SECURITY DEFINER/);
    expect(strip(m)).not.toMatch(/TRIGGER trg_process_flows_guard/);
  });
});

describe("app.codebook_rename — set by rename_codebook_code only, transaction-local, around its own writes", () => {
  it("no other numbered migration mentions the setting", () => {
    for (const f of files.filter((x) => x !== FILE)) expect(text(f), f).not.toContain("app.codebook_rename");
  });
  it("in this file it is SET twice, both in rename_codebook_code: after every check, right before the first write, and cleared right after the old row's delete (is_local = true)", () => {
    const sets = [...strip(m).matchAll(/set_config\('app\.codebook_rename'/g)];
    expect(sets).toHaveLength(2);
    const r = body("rename_codebook_code");
    const set = r.indexOf("PERFORM set_config('app.codebook_rename',");
    const firstWrite = r.indexOf("INSERT INTO codebook_entries");
    const upd = r.indexOf("UPDATE process_flows");
    const del = r.indexOf("DELETE FROM codebook_entries WHERE id = v_old.id;");
    const clear = r.indexOf("PERFORM set_config('app.codebook_rename', '', true);");
    expect(set).toBeGreaterThan(r.indexOf("USING ERRCODE = '40001'"));
    expect(set).toBeLessThan(firstWrite);
    expect(upd).toBeGreaterThan(set);
    expect(del).toBeGreaterThan(upd);
    expect(clear).toBeGreaterThan(del);
    expect(clear).toBeLessThan(r.indexOf("UPDATE codebook_entries SET id = v_old.id WHERE id = v_new_id;"));
    expect(r.slice(set, firstWrite)).toContain("jsonb_build_object('org', p_org_id::text, 'kind', p_kind, 'old', v_old_code, 'new', v_new_code)::text, true);");
  });
  it("its readers: process_flows_guard's CB-5 block (a unit rename only) and the version stamp (the rename's own delete bumps nothing)", () => {
    const readers = files.filter((f) => f <= FILE).flatMap((f) => [...strip(text(f)).matchAll(/current_setting\('app\.codebook_rename'/g)].map(() => f));
    expect(readers).toEqual([FILE, FILE]);
    expect(body("process_flows_guard")).toContain("current_setting('app.codebook_rename', true)");
    const v = body("codebook_entries_version_stamp");
    expect(v).toContain("current_setting('app.codebook_rename', true)");
    const skip = v.slice(v.indexOf("IF TG_OP = 'DELETE' THEN\n    v_rename"), v.indexOf("v_org := CASE"));
    expect(skip).toContain("AND (v_rename::jsonb ->> 'org') = OLD.org_id::text");
    expect(skip).toContain("AND (v_rename::jsonb ->> 'kind') = OLD.kind");
    expect(skip).toContain("AND (v_rename::jsonb ->> 'old') = OLD.code THEN\n      RETURN OLD;");
  });
});

describe("rename_codebook_code — DRLS-16, the controller tier, one transaction in the right order", () => {
  const r = body("rename_codebook_code");
  it("SECURITY DEFINER with search_path pinned; refuses a NULL uid (the shape dcHotfixAnonExecute reads) and anyone outside is_org_controller", () => {
    expect(r).toContain("LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(r).toContain("v_uid           uuid := auth.uid();");
    expect(r).toMatch(/\bIF\s+v_uid\s+IS\s+NULL\s+THEN\s+RAISE EXCEPTION 'rename_codebook_code: sign in/);
    expect(r).toContain("IF p_org_id IS NULL OR NOT is_org_controller(p_org_id) THEN");
    expect(r.indexOf("NOT is_org_controller(p_org_id)")).toBeLessThan(r.indexOf("INSERT INTO codebook_entries"));
    expect(r).not.toMatch(/'Admin'|'DocCtrl'/);
  });
  it("a controller who also holds Viewer or Auditor is refused (42501) before anything is counted or written — the same deny-if-any 20261045's assets UPDATE overlay applies to their direct write", () => {
    const check = "IF caller_holds_any_role(p_org_id, ARRAY['Viewer','Auditor']::text[]) THEN";
    expect(r).toContain(check);
    expect(r.slice(r.indexOf(check), r.indexOf("END IF;", r.indexOf(check)))).toContain("USING ERRCODE = '42501'");
    expect(r.indexOf(check)).toBeGreaterThan(r.indexOf("NOT is_org_controller(p_org_id)"));
    expect(r.indexOf(check)).toBeLessThan(r.indexOf("pg_advisory_xact_lock"));
    // the overlay it mirrors: the read-only pair, deny-if-any
    expect(text("20261045_rp_phase6_admin_gates_team_fk_reviewer_independence.sql"))
      .toContain("NOT caller_holds_any_role(org_id, ARRAY[''Viewer'',''Auditor'']::text[])");
    expect(m).toMatch(/controller who also holds a read-only role \(Viewer \/ Auditor\)/); // the header says so
  });
  it("EXECUTE: revoked from PUBLIC and anon, granted to authenticated only", () => {
    expect(m).toContain("REVOKE ALL ON FUNCTION rename_codebook_code(uuid, text, text, text, boolean, jsonb) FROM PUBLIC, anon;");
    expect(m).toContain("GRANT EXECUTE ON FUNCTION rename_codebook_code(uuid, text, text, text, boolean, jsonb) TO authenticated;");
    expect(strip(m)).not.toMatch(/GRANT[^;]*rename_codebook_code[^;]*(anon|service_role|PUBLIC)/i);
  });
  it("a rewritten head that would ALSO read as another unit and type is a blocker, for a unit and for a type rename", () => {
    expect(r.match(/SELECT COUNT\(\*\) INTO v_ambiguous_new FROM assets a/g)).toHaveLength(2);
    expect(r).toContain("AND v_new_code || substr(split_part(a.code, '.', 1), length(v_old_code) + 1) = u2.code || t2.code);");
    expect(r).toContain("AND u.code || v_new_code = u2.code || t2.code);");
    expect(r).toContain("would read, once renamed, both as %s %s and as another unit and type");
    expect(r.indexOf("IF v_ambiguous_new > 0 THEN")).toBeLessThan(r.indexOf("IF p_dry_run THEN RETURN v_counts; END IF;"));
  });
  it("the new code's mapping held by another operational unit is a blocker whether or not the old code is mapped (the filing would move into that unit)", () => {
    expect(r).toContain("SELECT COUNT(*) INTO v_unit_clash FROM units u WHERE u.org_id = p_org_id AND u.codebook_code = v_new_code;");
    expect(r).toContain("IF v_unit_clash > 0 THEN");
    expect(r).not.toContain("IF v_units > 0 AND v_unit_clash > 0 THEN");
    expect(r).toContain("is already mapped to another operational unit, and everything filed under %s would move into it");
    expect(r.indexOf("IF v_unit_clash > 0 THEN")).toBeLessThan(r.indexOf("IF p_dry_run THEN RETURN v_counts; END IF;"));
  });
  it("a flow that would start and end at the new code is a blocker: one between the two codes, or a legacy row already looping at the old one", () => {
    expect(r).toContain("AND ((f.from_ref = v_old_code AND f.to_ref = v_new_code) OR (f.from_ref = v_new_code AND f.to_ref = v_old_code)\n            OR (f.from_ref = v_old_code AND f.to_ref = v_old_code));");
    expect(r).toContain("would start and end at the same unit once %s becomes %s");
    expect(r.indexOf("IF v_flow_loop > 0 THEN")).toBeLessThan(r.indexOf("IF p_dry_run THEN RETURN v_counts; END IF;"));
  });
  it("the dry run, the blockers and the preview = apply check all come before the first write", () => {
    const firstWrite = r.indexOf("INSERT INTO codebook_entries");
    expect(r.indexOf("IF p_dry_run THEN RETURN v_counts; END IF;")).toBeLessThan(firstWrite);
    expect(r.indexOf("IF array_length(v_blockers, 1) > 0 THEN")).toBeLessThan(firstWrite);
    expect(r.indexOf("USING ERRCODE = '40001'")).toBeLessThan(firstWrite);
    expect(r).toContain("(v_counts - 'kind' - 'from' - 'to' - 'label' - 'blockers')");
  });
  it("the order: new row → assets → operational unit mapping → flows → the old row's delete (through 20261128's guard) → identity kept → audit", () => {
    const at = (s: string) => { const i = r.indexOf(s); expect(i, s).toBeGreaterThan(0); return i; };
    const steps = [
      at("INSERT INTO codebook_entries (org_id, kind, code, label, meta, sort, origin, created_by, created_at, updated_at)"),
      at("    UPDATE assets a\n       SET unit_code = CASE WHEN a.unit_code = v_old_code THEN v_new_code ELSE a.unit_code END,"),
      at("UPDATE units SET codebook_code = v_new_code WHERE org_id = p_org_id AND codebook_code = v_old_code;"),
      at("UPDATE process_flows\n"),
      at("DELETE FROM codebook_entries WHERE id = v_old.id;"),
      at("UPDATE codebook_entries SET id = v_old.id WHERE id = v_new_id;"),
      at("'CODEBOOK_CODE_RENAMED'"),
    ];
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    // one rename per org at a time; the entry locked
    expect(r).toContain("PERFORM pg_advisory_xact_lock(hashtextextended('rename_codebook_code:' || p_org_id::text, 0));");
    expect(r).toContain("   FOR UPDATE;");
  });
  it("the site-code head it rewrites is the head 20261128's guard counts (<unit><type> before the dot)", () => {
    const guard = fnIn(text("20261128_intel_roundG_registry_authority.sql"), "codebook_entries_guard_in_use")!;
    expect(guard).toContain("split_part(a.code, '.', 1) = OLD.code || t.code");
    expect(guard).toContain("split_part(a.code, '.', 1) = u.code || OLD.code");
    expect(r).toContain("split_part(a.code, '.', 1) = v_old_code || t.code");
    expect(r).toContain("split_part(a.code, '.', 1) = u.code || v_old_code");
  });
  it("20261128's in-use guard is not re-created or dropped here — the rename passes it", () => {
    expect(strip(m)).not.toMatch(/FUNCTION\s+codebook_entries_guard_in_use\s*\(/);
    expect(strip(m)).not.toMatch(/TRIGGER[^;]*trg_codebook_entries_guard_in_use/);
    expect(strip(m)).not.toMatch(/FUNCTION\s+codebook_entries_code_digits_guard\s*\(/);
  });
});

describe("CB-6 version triggers and ASK-8's rule", () => {
  it("every function this file defines pins search_path; only the rename is SECURITY DEFINER", () => {
    const defs = [...strip(m).matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(/g)].map((x) => x[1]);
    expect(defs.sort()).toEqual(["assert_legend_doc_ids", "assets_codebook_version_stamp", "codebook_config_version_guard", "codebook_entries_version_stamp", "knowledge_libraries_legend_guard", "knowledge_library_save_ai_features", "process_flows_guard", "rename_codebook_code"]);
    for (const d of defs) {
      const b = body(d);
      expect(b, d).toMatch(/SET search_path = public/);
      expect(/SECURITY DEFINER/.test(b), d).toBe(d === "rename_codebook_code");
    }
  });
  it("the trigger names sort after the triggers whose result they read (PostgreSQL fires BEFORE triggers by name, byte order)", () => {
    const byte = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
    expect(byte("trg_assets_codebook_version", "trg_assets_code_one_holder")).toBe(1);
    expect(byte("trg_codebook_entries_version_stamp", "trg_codebook_entries_guard_in_use")).toBe(1);
    expect(byte("trg_codebook_entries_version_stamp", "trg_codebook_entries_code_digits")).toBe(1);
    expect(m).toMatch(/CREATE TRIGGER trg_assets_codebook_version\n  BEFORE INSERT OR UPDATE OF code, codebook_version ON assets\n  FOR EACH ROW EXECUTE FUNCTION assets_codebook_version_stamp\(\);/);
    expect(m).toMatch(/CREATE TRIGGER trg_codebook_entries_version_stamp\n  BEFORE INSERT OR UPDATE OR DELETE ON codebook_entries\n/);
    expect(m).toMatch(/CREATE TRIGGER trg_codebook_config_version_guard\n  BEFORE INSERT OR UPDATE ON codebook_config\n/);
  });
  it("the service role never creates a codebook_config row (a restore inserts its own afterwards); an org being purged is skipped", () => {
    const e = body("codebook_entries_version_stamp");
    expect(e).toContain("IF EXISTS (SELECT 1 FROM orgs WHERE id = v_org) THEN");
    expect(e).toMatch(/IF auth\.uid\(\) IS NOT NULL THEN\n\s+INSERT INTO codebook_config AS c[\s\S]*ELSE\n\s+UPDATE codebook_config c SET codebook_version = c\.codebook_version \+ 1/);
    // a restore statement of N entries is ONE new version: the service-role
    // arm bumps once per org per transaction (transaction-local setting)
    const svc = e.slice(e.indexOf("ELSE\n      -- The service role"), e.indexOf("IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;"));
    expect(svc).toContain("v_bumped := COALESCE(current_setting('app.codebook_version_bumped', true), '');");
    expect(svc).toMatch(/IF position\(v_org::text IN v_bumped\) > 0 THEN\n\s+SELECT c\.codebook_version INTO v_version FROM codebook_config c WHERE c\.org_id = v_org;\n\s+ELSE\n\s+UPDATE codebook_config c SET codebook_version = c\.codebook_version \+ 1/);
    expect(svc).toContain("IF FOUND THEN\n          PERFORM set_config('app.codebook_version_bumped', v_bumped || v_org::text || ',', true);");
    for (const f of files.filter((x) => x !== FILE)) expect(text(f), f).not.toContain("app.codebook_version_bumped");
    // a label / link / binding edit is no new version
    expect(e).toContain("AND (NEW.meta -> 'tagPrefixes') IS NOT DISTINCT FROM (OLD.meta -> 'tagPrefixes') THEN");
  });
  it("a person cannot set an asset's stamp or lower the codebook version; a restore carries its own; a service-role insert with no stamp (the Bridge; a pre-20261178 backup) takes the version in force", () => {
    const a = body("assets_codebook_version_stamp");
    expect(a).toContain("IF auth.uid() IS NOT NULL THEN NEW.codebook_version := OLD.codebook_version; END IF;");
    expect(a).toContain("IF TG_OP = 'INSERT' AND auth.uid() IS NULL AND NEW.codebook_version IS NOT NULL THEN RETURN NEW; END IF;");
    expect(a).toContain("NEW.codebook_version := COALESCE((SELECT c.codebook_version FROM codebook_config c WHERE c.org_id = NEW.org_id), 1);");
    const c = body("codebook_config_version_guard");
    expect(c).toContain("IF NEW.codebook_version IS NULL OR NEW.codebook_version < OLD.codebook_version THEN");
  });
  it("ASK-8: an added legend id must be uuid-shaped and a knowledge document of the org; kept ids pass; anon cannot call the rule", () => {
    const l = body("assert_legend_doc_ids");
    expect(l).toContain("RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$");
    expect(l).toContain("IF v_old @> jsonb_build_array(v_el) THEN CONTINUE; END IF;");
    expect(l).toContain("IF NOT EXISTS (SELECT 1 FROM knowledge_documents k WHERE k.id = v_id::uuid AND k.org_id = p_org_id) THEN");
    expect(m).toContain("REVOKE ALL ON FUNCTION assert_legend_doc_ids(uuid, jsonb, jsonb) FROM PUBLIC, anon;");
    // the codebook save's upsert: the INSERT arm compares with the stored row
    expect(body("codebook_config_version_guard")).toContain("v_base := (SELECT c.legend_doc_ids FROM codebook_config c WHERE c.org_id = NEW.org_id);");
  });
  it("ASK-8: a person's direct write of knowledge_libraries.ai_features meets the same rule; it only refuses (never changes NEW); the service role passes", () => {
    const g = body("knowledge_libraries_legend_guard");
    expect(g).toContain("IF auth.uid() IS NULL THEN RETURN NEW; END IF;");
    expect(g).toContain("ELSIF (NEW.ai_features -> 'legendDocIds') IS DISTINCT FROM (OLD.ai_features -> 'legendDocIds') THEN");
    expect(strip(g)).not.toMatch(/NEW\.\w+\s*:=/);
    expect(m).toMatch(/CREATE TRIGGER trg_knowledge_libraries_legend_guard\n  BEFORE INSERT OR UPDATE OF ai_features ON knowledge_libraries\n  FOR EACH ROW EXECUTE FUNCTION knowledge_libraries_legend_guard\(\);/);
    // 20261121's embedBuild guard is neither re-created nor dropped here
    expect(strip(m)).not.toMatch(/knowledge_libraries_embed_build_guard\s*\(|DROP TRIGGER[^;]*embed_build_guard/);
  });
});

// The censuses two neighbouring packages' tests kept over the WHOLE sequence,
// moved here when 20261178 joined it so those files change by one line each
// (lib/__tests__/embedDrain.test.ts — I-18's; intelRoundGUnitIdentity.test.ts
// — I-13's): a known integrator conflict point, recorded on CB-5 / 99.
describe("censuses held for neighbouring migrations (20261121, 20261138)", () => {
  const SEM = "20261121_intel_roundG_semantic_layer.sql";
  const UNIT = "20261138_intel_roundG_unit_identity.sql";
  const lastDefiner = (re: RegExp) => files.filter((f) => re.test(strip(text(f)))).pop();
  it("20261178 is the newest definer of the toggles save; after 20261121 it is the only file adding a BEFORE trigger on knowledge_libraries; the embedBuild guard stays 20261121's", () => {
    expect(lastDefiner(/CREATE (OR REPLACE )?FUNCTION knowledge_library_save_ai_features\(/)).toBe(FILE);
    expect(files.filter((f) => f > SEM && /CREATE TRIGGER \w+\s+BEFORE [\w ,]*\bON knowledge_libraries\b/.test(strip(text(f))))).toEqual([FILE]);
    expect(lastDefiner(/CREATE TRIGGER trg_knowledge_libraries_embed_build_guard\b/)).toBe(SEM);
  });
  it("no migration after 20261138 re-creates what 20261138 created (20261178 only uses units.codebook_code)", () => {
    const later = files.filter((f) => f > UNIT).map((f) => strip(text(f)));
    for (const name of [
      "documents_total_for_org", "documents_unit_code_guard", "trg_documents_unit_code_guard",
      "units_org_codebook_code_uniq", "documents_org_unit_code_idx",
      "units_codebook_code_guard", "trg_units_codebook_code_guard",
      "assets_unit_id_follows_filing", "trg_assets_unit_id_follows_filing",
      "units_codebook_code_follow", "trg_units_codebook_code_follow",
    ]) {
      expect(later.some((s) => s.includes(name)), name).toBe(false);
    }
    expect(later.some((s) => /ADD COLUMN[^;]*\bcodebook_code\b|ALTER TABLE documents ADD COLUMN IF NOT EXISTS unit_code/.test(s))).toBe(false);
  });
});

describe("knowledge_library_save_ai_features — re-created from its newest definition plus ONE line", () => {
  const base = newestEarlier("knowledge_library_save_ai_features");
  const next = body("knowledge_library_save_ai_features");
  const ADDED = "       AND CASE WHEN l.id = p_library_id THEN assert_legend_doc_ids(l.org_id, p_features -> 'legendDocIds', l.ai_features -> 'legendDocIds') ELSE false END\n";
  it("the newest earlier definer is 20261121 (scan); the body minus the one line IS its body", () => {
    expect(base.file).toBe("20261121_intel_roundG_semantic_layer.sql");
    expect(next.replace(ADDED, "")).toBe(base.body);
    expect(lineDiff(base.body, next).onlyInA).toEqual([]);
    expect(lineDiff(base.body, next).onlyInB).toEqual([ADDED.replace(/\n$/, "")]);
  });
  it("still invoker rights (the caller's RLS decides the row), the embedBuild stamp kept, authenticated only", () => {
    expect(next).toContain("LANGUAGE sql VOLATILE SECURITY INVOKER");
    expect(next).toContain("THEN jsonb_build_object('embedBuild', l.ai_features -> 'embedBuild')");
    expect(m).toContain("REVOKE ALL ON FUNCTION knowledge_library_save_ai_features(UUID, JSONB) FROM public, anon;");
    expect(m).toContain("GRANT EXECUTE ON FUNCTION knowledge_library_save_ai_features(UUID, JSONB) TO authenticated;");
  });
  it("lib/knowledge.ts still calls it with the SQL's own parameter names", () => {
    expect(readFileSync(join(process.cwd(), "lib/knowledge.ts"), "utf8")).toContain('supabase.rpc("knowledge_library_save_ai_features", { p_library_id: libraryId, p_features: toggles })');
  });
});

describe("the final SELECT's prosrc probes name text that is in the body they check", () => {
  const tail = m.slice(m.indexOf("\nCOMMIT;\n"));
  const rows = tail.split(/\nUNION ALL\n/);
  const bodyOf = (name: string) => fnIn(m, name) ?? newestEarlier(name).body;
  it("every LIKE pattern on pg_proc.prosrc (quotes un-doubled) is a substring of that function's body", () => {
    let checked = 0;
    for (const row of rows) {
      const names = [...row.matchAll(/FROM pg_proc WHERE proname = '(\w+)'/g)].map((x) => x[1]);
      if (names.length === 0) continue;
      const pats = [...row.matchAll(/prosrc (NOT )?LIKE '((?:[^']|'')*)'/g)];
      for (const p of pats) {
        const pat = p[2].replace(/''/g, "'").replace(/^%|%$/g, "");
        const pieces = pat.split("%");
        const src = bodyOf(names[0]);
        let from = 0;
        for (const piece of pieces) {
          const i = src.indexOf(piece, from);
          expect(i, `${names[0]}: ${piece}`).toBeGreaterThanOrEqual(0);
          from = i + piece.length;
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
  it("no probe LIKEs pg_policies (none is needed) — so no deparsed-cast trap", () => {
    expect(tail).not.toContain("pg_policies");
  });
});
