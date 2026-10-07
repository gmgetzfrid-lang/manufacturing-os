// projects Round G — J14 PROJECTS FOLLOW-UPS: 20261179, the two database
// halves of projects-tab MON-12 that 20261157 left (done-when 1's two-step
// write; the award's one-company order — projects-and-cost COST-3 residual
// 3) and J12 fix pass 8's moved-answer window. The shape of the one paste
// (DEC-30), `award_quote` re-created from its NEWEST definition (found by
// scanning the sequence at test time) with nothing of its body lost, the new
// list, the move rail and the picker's RPC, and the app halves that read
// them. The behaviour was run on a scratch PostgreSQL 16 (the records name
// the scenarios and their answers).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EXPECTED_FUNCTIONS } from "@/lib/schemaExpectations";

const root = process.cwd();
const migDir = join(root, "supabase", "migrations");
const FILE = "20261179_prj_roundG_award_answers_for_each.sql";
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
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}
const fnIn = (text: string, name: string) => between(text, `CREATE OR REPLACE FUNCTION public.${name}(`, "\n$$;");
const fn = (name: string) => fnIn(C, name);

describe("the one-paste protocol (DEC-30)", () => {
  it("refuses to run before 20261157, then a TEMP inventory of COUNTs BEFORE the one transaction, and ONE final SELECT (check, ok, n)", () => {
    const guard = C.indexOf("Apply 20261157_prj_roundG_server_remainders.sql first");
    const temp = C.indexOf("CREATE TEMP TABLE prj_g_j14_inventory AS");
    const begin = C.indexOf("\nBEGIN;");
    const commit = C.indexOf("\nCOMMIT;");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(temp);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    expect(C.match(/\nBEGIN;/g)).toHaveLength(1);
    expect(C.match(/\nCOMMIT;/g)).toHaveLength(1);
    const tail = C.slice(commit);
    expect(tail).toMatch(/SELECT '(?:[^']|'')+' AS check,\s*\n\s*\([\s\S]*?\)[\s\S]*? AS ok,\s*\n\s*NULL::text AS n/);
    expect(tail.match(/;\s*$/gm)).toHaveLength(2); // "COMMIT;" and the one SELECT's end
    expect(tail).toMatch(/SELECT inventory, NULL::boolean, n FROM prj_g_j14_inventory;\s*$/);
    const inv = between(C, "CREATE TEMP TABLE prj_g_j14_inventory AS", "\nBEGIN;");
    // counts only, never rows
    const finalSel = inv.slice(inv.indexOf("\nSELECT 'inventory"));
    for (const sel of finalSel.split(/UNION ALL/)) expect(sel, sel).toMatch(/COUNT\(\*\)::text/);
    // the guard names every 20261157 function this file calls or re-creates
    const g = between(C, "DO $$", "END $$;");
    for (const f of ["cost_doc_company_barred(uuid,uuid,uuid,text)", "cost_doc_company_behind(uuid,uuid,uuid,text)", "company_name_key(text)", "award_quote(uuid,uuid,numeric,text,numeric)"]) {
      expect(g).toContain(`to_regprocedure('public.${f}')`);
    }
    // …and a re-run (the five-argument signature already gone) still passes it
    expect(g).toContain("to_regprocedure('public.award_quote(uuid,uuid,numeric,text,numeric,uuid,jsonb)') IS NULL");
  });

  it("the inventory is set-based — each do-not-use name key read ONCE (indexed), never a function call per quote per registry row (a 20,000-quote paste measured 0.65 s, against 2 min 27 s for the per-quote form)", () => {
    const inv = code(between(M, "-- ── DEC-30 inventory", "\nBEGIN;"));
    expect(inv).toContain("CREATE TEMP TABLE prj_g_j14_dnu AS");
    expect(inv).toContain("CREATE INDEX ON prj_g_j14_dnu (org_id, k);");
    expect(inv).not.toMatch(/cost_doc_compan(y|ies)_barred\(/);
    // section 1's order: the link decides alone; else the contractor's flagged company, the look-alike (exact name, then id), the bound company's flag
    expect(inv).toContain("WHEN q.link_id IS NOT NULL THEN (q.link_status IN ('do_not_use', 'inactive'))::int");
    expect(inv).toContain("ORDER BY (f.lname = lower(btrim(q.vendor_name))) DESC NULLS LAST, f.id");
    expect(inv).toContain("(CASE WHEN q.c_id IS NULL AND q.x_status IN ('do_not_use', 'inactive') THEN q.x_id END)) s(v))");
  });

  it("HOW TO APPLY / PASTE ORDER: after 20261157, and only once the app carrying J14 is deployed — and why", () => {
    const how = between(M, "-- HOW TO APPLY:", "\nDO $$");
    expect(how).toContain("PASTE ORDER: after 20261157");
    expect(how).toContain("AND only\n-- once the app carrying J14 is deployed");
    expect(how).toContain("section 3 would refuse that reasoned move until the\n-- J14 app, which moves it through relink_cost_document, is live");
    expect(how).toContain("20261157 is unpasted (HOLD) today, so this file pastes after it");
  });

  it("is named in the package's reserved number, and the sequence holds no other 20261179 and no 20261180", () => {
    expect(numbered().filter((f) => f.startsWith("20261179"))).toEqual([FILE]);
    expect(numbered().filter((f) => f.startsWith("20261180"))).toEqual([]);
    expect(FILE).toMatch(/^20261179_prj_roundG_[a-z_]+\.sql$/);
  });
});

describe("award_quote — re-created from its NEWEST definition with two arguments, nothing of its body lost", () => {
  const definers = () => numbered().filter((f) => /CREATE OR REPLACE FUNCTION public\.award_quote\(/.test(mig(f)));
  it("the newest earlier definition is found by scanning the sequence (today 20261157), and this file is the newest of all", () => {
    const ds = definers();
    expect(ds[ds.length - 1]).toBe(FILE);
    expect(ds[ds.length - 2]).toBe("20261157_prj_roundG_server_remainders.sql");
  });

  it("lineDiff: only the last argument's comma and the return gain; the added lines are exactly the two arguments, the declarations, the moved-answer refusal, the other companies' reasons and their rows", () => {
    const ds = definers();
    const live = fnIn(mig(ds[ds.length - 2]), "award_quote");
    const next = fnIn(M, "award_quote");
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual([
      "  p_confirmed_total numeric DEFAULT NULL",
      "    'company', v_company, 'override', v_flagged);",
    ]);
    expect(onlyInB.filter((l) => !/^\s*--/.test(l))).toEqual([
      "  p_confirmed_total numeric DEFAULT NULL,",
      "  p_override_company uuid DEFAULT NULL,",
      "  p_also_overrides jsonb DEFAULT NULL",
      "  v_also jsonb := '[]'::jsonb;",
      "  v_also_one jsonb;",
      "  v_also_reason text;",
      "  v_also_given jsonb := '[]'::jsonb;",
      "  IF v_flagged AND p_override_company IS NOT NULL AND (v_barred ->> 'id') IS DISTINCT FROM p_override_company::text THEN",
      "    RETURN jsonb_build_object('ok', false, 'code', 'company_moved', 'company', v_barred, 'expected', p_override_company);",
      "  v_also := COALESCE(cost_doc_companies_barred(v_doc.org_id, NULLIF(v_raw ->> 'company_id', '')::uuid, v_doc.party_id, v_doc.vendor_name), '[]'::jsonb) - 0;",
      "  FOR v_also_one IN SELECT e FROM jsonb_array_elements(v_also) e LOOP",
      "    SELECT NULLIF(btrim(COALESCE(g ->> 'reason', '')), '') INTO v_also_reason",
      "      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_also_overrides) = 'array' THEN p_also_overrides ELSE '[]'::jsonb END) g",
      "     WHERE g ->> 'companyId' = v_also_one ->> 'id' AND NULLIF(btrim(COALESCE(g ->> 'reason', '')), '') IS NOT NULL",
      "     LIMIT 1;",
      "    IF v_also_reason IS NULL THEN",
      "      RETURN jsonb_build_object('ok', false, 'code', 'company_flagged', 'company', v_also_one, 'also', true);",
      "    v_also_given := v_also_given || jsonb_build_array(v_also_one || jsonb_build_object('reason', v_also_reason));",
      "  END LOOP;",
      "  FOR v_also_one IN SELECT e FROM jsonb_array_elements(v_also_given) e LOOP",
      "            jsonb_build_object('companyId', v_also_one ->> 'id', 'companyName', v_also_one ->> 'name',",
      "                               'companyStatus', v_also_one ->> 'status', 'reason', v_also_one ->> 'reason', 'also', true));",
      "  END LOOP;",
      "            'alsoOverridden', (SELECT COALESCE(jsonb_agg(e ->> 'id'), '[]'::jsonb) FROM jsonb_array_elements(v_also_given) e),",
      "    'company', v_company, 'override', v_flagged, 'also', v_also_given);",
    ]);
    expect(onlyInB.filter((l) => /^\s*--/.test(l)).length).toBeGreaterThan(0);
  });

  it("both refusals come before the claim (a refusal writes nothing), after the first company's own; the override GUC is still the first company's alone", () => {
    const f = fn("award_quote");
    const claim = f.indexOf("SET status = 'awarded'");
    expect(f.indexOf("'company_flagged', 'company', v_barred")).toBeLessThan(f.indexOf("'company_moved'"));
    expect(f.indexOf("'company_moved'")).toBeLessThan(claim);
    expect(f.indexOf("'also', true);\n    END IF;")).toBeLessThan(claim);
    expect(f).toContain("IF v_flagged THEN PERFORM set_config('app.cost_doc_award_override', p_doc::text, true); END IF;");
    // the other companies' rows are written after the first's, inside the one body
    expect(f.indexOf("'reason', v_also_one ->> 'reason', 'also', true")).toBeGreaterThan(f.indexOf("'companyStatus', v_barred ->> 'status', 'reason', v_override"));
  });

  it("the five-argument signature is dropped first (two candidates would be PGRST203); grants follow the seven-argument one (DRLS-16: NULL auth.uid() refused in the body, anon revoked)", () => {
    const drop = C.indexOf("DROP FUNCTION IF EXISTS public.award_quote(uuid, uuid, numeric, text, numeric);");
    expect(drop).toBeGreaterThan(C.indexOf("\nBEGIN;"));
    expect(drop).toBeLessThan(C.indexOf("CREATE OR REPLACE FUNCTION public.award_quote("));
    expect(fn("award_quote")).toMatch(/IF v_uid IS NULL THEN\s*\n\s*RAISE EXCEPTION/);
    expect(C).toContain("REVOKE ALL ON FUNCTION public.award_quote(uuid, uuid, numeric, text, numeric, uuid, jsonb) FROM PUBLIC;");
    expect(C).toContain("REVOKE ALL ON FUNCTION public.award_quote(uuid, uuid, numeric, text, numeric, uuid, jsonb) FROM anon;");
    expect(C).toContain("GRANT EXECUTE ON FUNCTION public.award_quote(uuid, uuid, numeric, text, numeric, uuid, jsonb) TO authenticated;");
    expect(fn("award_quote")).toMatch(/SECURITY INVOKER\s*\nSET search_path = public/);
  });
});

describe("section 1 — cost_doc_companies_barred, beside an UNCHANGED cost_doc_company_barred", () => {
  it("cost_doc_company_barred is not re-created: its newest definition is still 20261157's", () => {
    const ds = numbered().filter((f) => /CREATE OR REPLACE FUNCTION public\.cost_doc_company_barred\(/.test(mig(f)));
    expect(ds[ds.length - 1]).toBe("20261157_prj_roundG_server_remainders.sql");
    expect(C).not.toMatch(/CREATE OR REPLACE FUNCTION public\.cost_doc_company_(barred|behind)\(/);
  });

  it("its answer FIRST, a person's link deciding alone, then the look-alike — the very query cost_doc_company_barred runs — and the bound company's flag, each once; SECURITY INVOKER, search_path pinned, anon revoked", () => {
    const f = fn("cost_doc_companies_barred");
    expect(f).toMatch(/LANGUAGE plpgsql STABLE\s*\nSECURITY INVOKER\s*\nSET search_path = public/);
    const first = f.indexOf("v_first := cost_doc_company_barred(p_org, p_company, p_party, p_vendor);");
    const link = f.indexOf("IF p_company IS NOT NULL AND EXISTS (SELECT 1 FROM companies c WHERE c.id = p_company AND c.org_id = p_org) THEN\n    RETURN v_list;");
    const look = f.indexOf("v_key := company_name_key(p_vendor);");
    const bound = f.indexOf("v_bound := cost_doc_company_behind(p_org, NULL, p_party, p_vendor);");
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(link);
    expect(link).toBeLessThan(look);
    expect(look).toBeLessThan(bound);
    // the look-alike query, line for line, is 20261157's (so the two name the same row)
    const barred157 = fnIn(code(mig("20261157_prj_roundG_server_remainders.sql")), "cost_doc_company_barred");
    for (const line of [
      "    SELECT jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status) INTO v_row",
      "      FROM companies c",
      "     WHERE c.org_id = p_org AND c.status = 'do_not_use'",
      "       AND company_name_key(c.name) = v_key",
      "     ORDER BY (lower(c.name) = lower(btrim(p_vendor))) DESC NULLS LAST, c.id",
      "     LIMIT 1;",
    ]) {
      expect(barred157).toContain(line);
      expect(f).toContain(line.replace("INTO v_row", "INTO v_look"));
    }
    // each once (never the first again)
    expect(f.match(/NOT v_list @> jsonb_build_array\(jsonb_build_object\('id', v_(look|bound) -> 'id'\)\)/g)).toHaveLength(2);
    expect(f).toContain("IF v_bound ->> 'status' IN ('do_not_use', 'inactive')");
    expect(C).toContain("REVOKE ALL ON FUNCTION public.cost_doc_companies_barred(uuid, uuid, uuid, text) FROM PUBLIC;");
    expect(C).toContain("REVOKE ALL ON FUNCTION public.cost_doc_companies_barred(uuid, uuid, uuid, text) FROM anon;");
    expect(C).toContain("GRANT EXECUTE ON FUNCTION public.cost_doc_companies_barred(uuid, uuid, uuid, text) TO authenticated, service_role;");
  });

  it("lib/costDocs.ts companyBehind keeps the same list: barred (unchanged) then `also` — the look-alike, then the bound company's flag, never barred itself; a person's link answers alone", () => {
    const lib = src("lib/costDocs.ts");
    const cb = between(lib, "async function companyBehind(", "\n}\n");
    expect(cb).toContain("if (hit.company) return { company: hit.company, barred: flaggedOrNull(hit.company), also: [] };");
    expect(cb).toContain("const barred = flagged ?? lookAlike.company;");
    expect(cb).toContain("return { company: hit.company, barred, also: others(barred, lookAlike.company, flagged) };");
    expect(cb).toContain("const barred = lookAlike.company ?? boundFlag;");
    expect(cb).toContain("return { company: bound, barred, also: others(barred, lookAlike.company, boundFlag) };");
    expect(cb).toContain("if (c && c.id !== first?.id && !out.some((o) => o.id === c.id)) out.push(c);");
  });
});

describe("section 3 — the move rail: an open quote is not moved off a flagged company without a reason", () => {
  const f = () => fn("enforce_cost_document_company_move");
  it("SECURITY DEFINER with search_path pinned, EXECUTE revoked from PUBLIC, anon and authenticated (DRLS-16); BEFORE UPDATE with no column list (company_id is 20261096's, read through to_jsonb)", () => {
    expect(f()).toMatch(/SECURITY DEFINER\s*\nSET search_path = public/);
    for (const r of ["PUBLIC", "anon", "authenticated"]) expect(C).toContain(`REVOKE ALL ON FUNCTION public.enforce_cost_document_company_move() FROM ${r};`);
    expect(C).toMatch(/CREATE TRIGGER trg_cost_documents_company_move\s*\n\s*BEFORE UPDATE ON cost_documents\s*\n\s*FOR EACH ROW EXECUTE FUNCTION public\.enforce_cost_document_company_move\(\);/);
    expect(f()).toContain("v_old_company uuid := NULLIF(to_jsonb(OLD) ->> 'company_id', '')::uuid;");
    expect(f()).not.toMatch(/\b(OLD|NEW)\.company_id\b/);
  });

  it("passes, in order: the service role; a decided quote or another kind; a write that changes none of the three; an FK SET NULL one level down; the relink override for this one document — then judges the list before against the list after", () => {
    const body = f();
    const at = (s: string) => { const i = body.indexOf(s); expect(i, s).toBeGreaterThan(0); return i; };
    const order = [
      "IF auth.uid() IS NULL THEN RETURN NEW; END IF;",
      "IF OLD.kind IS DISTINCT FROM 'quote' OR OLD.status NOT IN ('draft', 'parsed') THEN RETURN NEW; END IF;",
      "AND v_new_company IS NOT DISTINCT FROM v_old_company THEN",
      "IF pg_trigger_depth() > 1",
      "IF COALESCE(current_setting('app.cost_doc_relink_override', true), '') = NEW.id::text THEN RETURN NEW; END IF;",
      "v_before := cost_doc_companies_barred(OLD.org_id, v_old_company, OLD.party_id, OLD.vendor_name);",
      "v_after := cost_doc_companies_barred(NEW.org_id, v_new_company, NEW.party_id, NEW.vendor_name);",
      "WHERE NOT v_after @> jsonb_build_array(jsonb_build_object('id', e -> 'id'))",
      "USING ERRCODE = 'check_violation';",
    ].map(at);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body).toContain("((v_new_company IS NULL AND v_old_company IS NOT NULL) OR (NEW.party_id IS NULL AND OLD.party_id IS NOT NULL))");
  });

  it("20261157's award rail is untouched by this file (it still judges the first company, and the override GUC is still award_quote's)", () => {
    expect(C).not.toContain("CREATE OR REPLACE FUNCTION public.enforce_cost_document_award_registry(");
    expect(C).not.toMatch(/DROP TRIGGER IF EXISTS trg_cost_documents_award_registry/);
  });
});

describe("section 4 — relink_cost_document: the picker's move, its reason and its record in one transaction", () => {
  const f = () => fn("relink_cost_document");
  it("SECURITY INVOKER with search_path pinned; a NULL auth.uid() refused (DRLS-16); anon revoked, authenticated granted", () => {
    expect(f()).toMatch(/SECURITY INVOKER\s*\nSET search_path = public/);
    expect(f()).toMatch(/IF v_uid IS NULL THEN\s*\n\s*RAISE EXCEPTION/);
    expect(C).toContain("REVOKE ALL ON FUNCTION public.relink_cost_document(uuid, uuid, text) FROM PUBLIC;");
    expect(C).toContain("REVOKE ALL ON FUNCTION public.relink_cost_document(uuid, uuid, text) FROM anon;");
    expect(C).toContain("GRANT EXECUTE ON FUNCTION public.relink_cost_document(uuid, uuid, text) TO authenticated;");
  });

  it("locks the quote, refuses a decided one and another org's company, answers reason_required BEFORE it moves anything, moves under the GUC (cleared after) and writes COST_DOC_COMPANY_LINKED in the same body", () => {
    const body = f();
    const lock = body.indexOf("SELECT * INTO v_doc FROM cost_documents WHERE id = p_doc FOR UPDATE;");
    const noCol = body.indexOf("IF NOT (v_raw ? 'company_id') THEN RETURN jsonb_build_object('ok', false, 'code', 'no_column'); END IF;");
    const decided = body.indexOf("'code', 'decided'");
    const company = body.indexOf("RETURN jsonb_build_object('ok', false, 'code', 'company');");
    const need = body.indexOf("'code', 'reason_required', 'leaving', v_leaving");
    const set = body.indexOf("PERFORM set_config('app.cost_doc_relink_override', p_doc::text, true);");
    const upd = body.indexOf("UPDATE cost_documents SET company_id = p_company");
    const clear = body.indexOf("PERFORM set_config('app.cost_doc_relink_override', '', true);");
    const audit = body.indexOf("VALUES ('COST_DOC_COMPANY_LINKED', 'cost', p_doc::text, v_doc.org_id, v_uid, v_email,");
    for (const i of [lock, noCol, decided, company, need, set, upd, clear, audit]) expect(i).toBeGreaterThan(0);
    expect([lock, noCol, decided, company, need, set, upd, clear, audit]).toEqual([lock, noCol, decided, company, need, set, upd, clear, audit].sort((a, b) => a - b));
    expect(body).toContain("WHERE id = p_doc AND status IN ('draft', 'parsed');");
    // the row keeps the picker's shape (overrideDoNotUse) and names every company left
    expect(body).toContain("'overrideDoNotUse', jsonb_build_object('companyId', v_leaving -> 0 ->> 'id'");
    expect(body).toContain("'leaving', v_leaving, 'reason', v_reason)");
  });
});

describe("the app halves (J14)", () => {
  it("lib/costDocs.ts sends the new arguments only when it has them, and retries 20261157's five-argument call on PGRST202, recording the other companies' overrides itself", () => {
    const lib = src("lib/costDocs.ts");
    expect(lib).toContain("if (override && verdict.barred) extra.p_override_company = answers.overrideCompanyId ?? verdict.barred.id;");
    expect(lib).toContain("if (alsoGiven.length) extra.p_also_overrides = alsoGiven;");
    expect(lib).toContain('res = await supabase.rpc("award_quote", { ...base, ...extra });');
    expect(lib).toContain("if (res.error && isMissingRpc(res.error) && !legacy) {");
    expect(lib).toContain('res = await supabase.rpc("award_quote", base);');
    expect(lib).toContain('res = await supabase.rpc("relink_cost_document", { p_doc: input.docId, p_company: input.companyId, p_reason: input.reason?.trim() || null });');
  });

  it("the bid tab asks the database's whole list (falling back to the one-company question while it is missing) and its picker moves the link through the server", () => {
    const panel = src("components/projects/cost/QuotesPanel.tsx");
    expect(panel).toContain('await supabase.rpc("cost_doc_companies_barred", {');
    expect(panel).toContain("const override = listed ? listed[0] ?? null : await companyAwardAnswersFor(bid, linkedCompany, barredRows);");
    expect(panel).toContain("const first = await relinkQuoteCompany({ docId: doc.id, companyId });");
    expect(panel).toContain("if (first !== RELINK_RPC_MISSING) {");
  });

  it("schema health probes both new functions against this file, with an argument their uuid parameter refuses", () => {
    for (const name of ["cost_doc_companies_barred", "relink_cost_document"]) {
      const e = EXPECTED_FUNCTIONS.find((f) => f.fn === name)!;
      expect(e.migration).toBe(FILE);
      expect(C).toContain(`CREATE OR REPLACE FUNCTION public.${name}(`);
      const firstUuid = Object.values(e.probeArgs)[0];
      expect(String(firstUuid)).toBe("schema-health-probe");
    }
  });
});
