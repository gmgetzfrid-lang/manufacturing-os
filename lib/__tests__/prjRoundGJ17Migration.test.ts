// projects Round G — J17 BARRED LOOK-ALIKE: 20261190, projects-and-cost
// COST-3 residual 2 (DEC-90 A21, the Apex ruling) — the do-not-use GATE, never
// the binding, answers for a registry row whose normalised name LEADS the
// vendor name's. The shape of the one paste (DEC-30), the two gate functions
// re-created from their NEWEST definitions (found by scanning the sequence at
// test time) with only the look-alike query changed, the binding and every
// caller left alone, DRLS-16, and the parity of the SQL with the TypeScript
// twins (lib/bidTab.ts companyKeyLeads / barredCompanyFor, lib/costDocs.ts
// flaggedLookAlike). The behaviour was run on a scratch PostgreSQL 16 (the
// record names the scenarios and their answers).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { companyKeyLeads, normalizeCompanyName, barredCompanyFor } from "@/lib/bidTab";

const root = process.cwd();
const migDir = join(root, "supabase", "migrations");
const FILE = "20261190_prj_roundG_barred_look_alike.sql";
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
/** The files that define `name`, in sequence order. */
const definers = (name: string) => numbered().filter((f) => new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(`).test(code(mig(f))));

const OLD_LOOK = [
  "       AND company_name_key(c.name) = v_key",
  "     ORDER BY (lower(c.name) = lower(btrim(p_vendor))) DESC NULLS LAST, c.id",
];
const NEW_LOOK = [
  "      CROSS JOIN LATERAL (SELECT company_name_key(c.name) AS k) n",
  "       AND n.k <> '' AND (n.k = v_key OR starts_with(v_key, n.k || ' '))",
  "     ORDER BY (lower(c.name) = lower(btrim(p_vendor))) DESC NULLS LAST, length(n.k) DESC, c.id",
];

describe("the one-paste protocol (DEC-30)", () => {
  it("refuses to run before 20261157 and 20261179, then a TEMP inventory of COUNTs BEFORE the one transaction, and ONE final SELECT (check, ok, n)", () => {
    const guard = C.indexOf("Apply 20261157_prj_roundG_server_remainders.sql and then 20261179_prj_roundG_award_answers_for_each.sql first");
    const temp = C.indexOf("CREATE TEMP TABLE prj_g_j17_inventory AS");
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
    expect(tail).toMatch(/SELECT inventory, NULL::boolean, n FROM prj_g_j17_inventory;\s*$/);
    // counts only, never rows
    const inv = between(C, "CREATE TEMP TABLE prj_g_j17_inventory AS", "\nBEGIN;");
    const finalSel = inv.slice(inv.indexOf("\nSELECT 'inventory"));
    const parts = finalSel.split(/UNION ALL/);
    expect(parts).toHaveLength(4);
    for (const sel of parts) expect(sel, sel).toMatch(/COUNT\(\*\)::text/);
    // the guard names every function this file re-creates or relies on
    const g = between(C, "DO $$", "END $$;");
    for (const f of ["cost_doc_company_barred(uuid,uuid,uuid,text)", "cost_doc_company_behind(uuid,uuid,uuid,text)", "company_name_key(text)", "cost_doc_companies_barred(uuid,uuid,uuid,text)"]) {
      expect(g).toContain(`to_regprocedure('public.${f}') IS NULL`);
    }
  });

  it("the inventory is set-based and linear — each quote's leading words are materialised BEFORE one equality lookup (a scratch paste of 20,000 quotes beside 1,000 flagged rows measured 170 s for the product form, 2.5 s for this one) — and never calls a gate function per quote", () => {
    const inv = code(between(M, "-- ── DEC-30 inventory", "\nBEGIN;"));
    expect(inv).toContain("CREATE TEMP TABLE prj_g_j17_dnu AS");
    expect(inv).toContain("CREATE INDEX ON prj_g_j17_dnu (org_id, k);");
    expect(inv).toContain("ANALYZE prj_g_j17_dnu;");
    expect(inv).not.toMatch(/cost_doc_compan(y|ies)_barred\(/);
    const leads = between(inv, "prj_g_j17_leads AS MATERIALIZED (", "\n),");
    expect(leads).toContain("CROSS JOIN LATERAL generate_series(1, cardinality(string_to_array(q.k, ' ')) - 1) AS w(n)");
    expect(leads).toContain("array_to_string((string_to_array(q.k, ' '))[1:w.n], ' ') AS lead");
    expect(leads).not.toContain("prj_g_j17_dnu f");                                   // the lookup is the next CTE's
    const leading = between(inv, "prj_g_j17_leading AS MATERIALIZED (", "\n),");
    expect(leading).toContain("JOIN prj_g_j17_dnu f ON f.org_id = l.org_id AND f.k = l.lead");
    // section 1's order: the longest leading key (more words is a longer string of the same key), then id
    expect(leading).toContain("ORDER BY l.id, l.words DESC, f.id");
    // counted: no person's link of the org, no equal key, and not the contractor's flagged company
    expect(inv).toContain("WHERE lc.id = NULLIF(to_jsonb(d) ->> 'company_id', '')::uuid AND lc.org_id = d.org_id)");
    expect(inv).toContain("AND NOT EXISTS (SELECT 1 FROM prj_g_j17_dnu e WHERE e.org_id = q.org_id AND e.k = q.k)");
    expect(inv).toContain("WHERE l.look_id IS DISTINCT FROM l.contractor_flagged");
  });

  it("HOW TO APPLY / PASTE ORDER: after 20261157 AND 20261179, in the same window, and either deploy order works — said with why", () => {
    const how = between(M, "-- HOW TO APPLY:", "\nDO $$");
    expect(how).toContain("PASTE ORDER: after 20261157 AND 20261179");
    expect(how).toContain("this file\n-- pastes after 20261179, in the same window");
    expect(how).toContain("this file adds no\n-- function and changes no signature (no new 42883 / PGRST202 path)");
    expect(how).toContain("the J17 app before this paste");
    expect(how).toContain("this paste before the J17 app");
    expect(how).toContain("before 20261157 (today)");
  });

  it("is named in the package's reserved number, and the sequence holds no other 20261190", () => {
    expect(numbered().filter((f) => f.startsWith("20261190"))).toEqual([FILE]);
    expect(FILE).toMatch(/^20261190_prj_roundG_[a-z_]+\.sql$/);
  });
});

describe("the two gate functions — re-created from their NEWEST definitions, only the look-alike query changed", () => {
  it("cost_doc_company_barred: the newest earlier definition (found by scanning: today 20261157's) differs from this file's in the look-alike query only", () => {
    const ds = definers("cost_doc_company_barred");
    expect(ds[ds.length - 1]).toBe(FILE);
    const prev = ds[ds.length - 2];
    expect(prev).toBe("20261157_prj_roundG_server_remainders.sql");
    const { onlyInA, onlyInB } = lineDiff(fnIn(code(mig(prev)), "cost_doc_company_barred"), fn("cost_doc_company_barred"));
    expect(onlyInA).toEqual(OLD_LOOK);
    expect(onlyInB).toEqual(NEW_LOOK);
  });

  it("cost_doc_companies_barred: the newest earlier definition (today 20261179's) differs in the same lines, INTO v_look", () => {
    const ds = definers("cost_doc_companies_barred");
    expect(ds[ds.length - 1]).toBe(FILE);
    const prev = ds[ds.length - 2];
    expect(prev).toBe("20261179_prj_roundG_award_answers_for_each.sql");
    const { onlyInA, onlyInB } = lineDiff(fnIn(code(mig(prev)), "cost_doc_companies_barred"), fn("cost_doc_companies_barred"));
    expect(onlyInA).toEqual(OLD_LOOK);
    expect(onlyInB).toEqual(NEW_LOOK);
    // the two functions run the very same query, so the list names the row the first answer names
    const look = (f: string) => between(f, "      FROM companies c\n      CROSS JOIN LATERAL", "     LIMIT 1;");
    expect(look(fn("cost_doc_companies_barred"))).toBe(look(fn("cost_doc_company_barred")));
  });

  it("nothing else is re-created: the key, the BINDING, the award rail, award_quote, the move rail and the picker's RPC call the two functions by name", () => {
    for (const other of ["company_name_key", "cost_doc_company_behind", "award_quote", "enforce_cost_document_award_registry", "enforce_cost_document_company_move", "relink_cost_document"]) {
      expect(C, other).not.toContain(`CREATE OR REPLACE FUNCTION public.${other}(`);
    }
    expect(C).not.toMatch(/DROP FUNCTION|CREATE TRIGGER|DROP TRIGGER|CREATE POLICY|ALTER TABLE/);
    expect(definers("cost_doc_company_behind")).toEqual(["20261157_prj_roundG_server_remainders.sql"]);
    expect(definers("company_name_key")).toEqual(["20261157_prj_roundG_server_remainders.sql"]);
    // the callers, in their newest definitions
    expect(fnIn(code(mig("20261157_prj_roundG_server_remainders.sql")), "enforce_cost_document_award_registry")).toContain("v_company := cost_doc_company_barred(NEW.org_id,");
    const m179 = code(mig("20261179_prj_roundG_award_answers_for_each.sql"));
    expect(fnIn(m179, "award_quote")).toContain("v_also := COALESCE(cost_doc_companies_barred(");
    expect(fnIn(m179, "enforce_cost_document_company_move")).toContain("v_before := cost_doc_companies_barred(OLD.org_id, v_old_company, OLD.party_id, OLD.vendor_name);");
    expect(fnIn(m179, "relink_cost_document")).toContain("cost_doc_companies_barred(v_doc.org_id, v_prev,");
  });

  it("DRLS-16: no SECURITY DEFINER here; both functions SECURITY INVOKER with search_path pinned, EXECUTE revoked from PUBLIC and anon, granted to authenticated and service_role", () => {
    expect(C).not.toContain("SECURITY DEFINER");
    for (const name of ["cost_doc_company_barred", "cost_doc_companies_barred"]) {
      expect(fn(name)).toMatch(/LANGUAGE plpgsql STABLE\s*\nSECURITY INVOKER\s*\nSET search_path = public/);
      expect(C).toContain(`REVOKE ALL ON FUNCTION public.${name}(uuid, uuid, uuid, text) FROM PUBLIC;`);
      expect(C).toContain(`REVOKE ALL ON FUNCTION public.${name}(uuid, uuid, uuid, text) FROM anon;`);
      expect(C).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(uuid, uuid, uuid, text) TO authenticated, service_role;`);
    }
  });
});

describe("the SQL and the TypeScript are one rule (lib/bidTab.ts, lib/costDocs.ts)", () => {
  it("the leading-name test: SQL `n.k <> '' AND (n.k = v_key OR starts_with(v_key, n.k || ' '))` is companyKeyLeads; the paste probe's vectors give the same answers in TypeScript", () => {
    const ts = src("lib/bidTab.ts");
    expect(between(ts, "export function companyKeyLeads(", "\n}\n")).toContain('return registryKey !== "" && (vendorKey === registryKey || vendorKey.startsWith(`${registryKey} `));');
    const probe = between(C, "(SELECT bool_and(", ") AS t(r, v, want))");
    const vectors = [...probe.matchAll(/\('((?:[^']|'')*)', '((?:[^']|'')*)', (true|false)\)/g)].map((m) => [m[1].replace(/''/g, "'"), m[2].replace(/''/g, "'"), m[3] === "true"] as const);
    expect(vectors.length).toBeGreaterThanOrEqual(9);
    for (const [r, v, want] of vectors) expect(companyKeyLeads(normalizeCompanyName(r), normalizeCompanyName(v)), `${r} / ${v}`).toBe(want);
    // the probe tests the expression the functions run, on company_name_key's keys
    expect(probe).toContain("(company_name_key(t.r) <> '' AND (company_name_key(t.r) = company_name_key(t.v) OR starts_with(company_name_key(t.v), company_name_key(t.r) || ' '))) = t.want");
  });

  it("the order: the exact name, then the longest key, then id — in SQL, in barredCompanyFor and in flaggedLookAlike", () => {
    expect(fn("cost_doc_company_barred")).toContain("ORDER BY (lower(c.name) = lower(btrim(p_vendor))) DESC NULLS LAST, length(n.k) DESC, c.id");
    const bid = between(src("lib/bidTab.ts"), "export function barredCompanyFor<", "\n}\n");
    expect(bid).toContain("const keyLength = (c: T) => normalizeCompanyName(c.name).length;");
    expect(bid).toContain(".sort((a, b) => isExact(b) - isExact(a) || keyLength(b) - keyLength(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ?? null;");
    expect(bid).toContain("return companyCandidatesByName(vendorName, registry).filter((c) => c.status === \"do_not_use\")");
    const look = between(src("lib/costDocs.ts"), "async function flaggedLookAlike(", "\n}\n");
    expect(look).toContain("hits.push(...rows.filter((c) => companyKeyLeads(normalizeCompanyName(c.name), key)));");
    expect(look).toContain("const keyLength = (c: CompanyRow) => normalizeCompanyName(c.name).length;");
    expect(look).toContain("Number(b.name.toLowerCase() === exact) - Number(a.name.toLowerCase() === exact) || keyLength(b) - keyLength(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)");
    // the lib's read narrows on the key's FIRST word, which every candidate's key — equal or leading — begins with
    expect(look).toContain('const first = key.split(" ")[0];');
    expect(look).toContain('const word = first !== "and" ? first : null;');
    // and the TypeScript order names what the SQL names on the scratch run's case (Q-77 / Q-78)
    const reg = [
      { id: "00000000-0000-0000-0000-0000000007c6", name: "Gulf Mechanical", status: "do_not_use" },
      { id: "00000000-0000-0000-0000-0000000007c7", name: "Gulf", status: "do_not_use" },
      { id: "00000000-0000-0000-0000-0000000007ca", name: "Gulf Mechanical, Inc.", status: "do_not_use" },
    ];
    expect(barredCompanyFor("Gulf Mechanical Services", null, reg)?.name).toBe("Gulf Mechanical");
    expect(barredCompanyFor("Gulf Mechanical Inc", null, reg)?.name).toBe("Gulf Mechanical");
  });

  it("the BINDING stays exact: matchCompanyByName reads companiesNamedAlike (never a leading name), and the bid tab's ambiguity note reads it too", () => {
    const ts = src("lib/bidTab.ts");
    const match = between(ts, "export function matchCompanyByName<", "\n}\n");
    expect(match).toContain("const hits = companiesNamedAlike(vendorName, companies);");
    expect(match).not.toContain("companyCandidatesByName");
    expect(between(ts, "export function companiesNamedAlike<", "\n}\n")).toContain("return companies.filter((c) => normalizeCompanyName(c.name) === key);");
    expect(src("components/projects/cost/QuotesPanel.tsx")).toContain("candidates: companiesNamedAlike(e.vendorName, companies),");
  });

  it("every prosrc pattern the final SELECT probes for the two functions is in this file's own bodies (the probe can read true)", () => {
    const tail = C.slice(C.indexOf("\nCOMMIT;"));
    for (const name of ["cost_doc_company_barred", "cost_doc_companies_barred"]) {
      const probe = between(tail, "SELECT ", `FROM pg_proc WHERE proname = '${name}' AND pronargs = 4)`);
      const body = fn(name);
      const likes = [...probe.matchAll(/prosrc (NOT )?LIKE '%((?:[^']|'')*)%'/g)];
      expect(likes.length).toBeGreaterThanOrEqual(4);
      for (const [, not, pat] of likes) {
        const text = pat.replace(/''/g, "'");
        if (not) expect(body, text).not.toContain(text);
        else expect(body, text).toContain(text);
      }
    }
  });
});
