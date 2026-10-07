// projects Round G — J12 SERVER REMAINDERS: the shape of 20261157 — the
// registry rail on an award (projects-tab MON-12), the award as one
// transaction (GAP-406), the one-request checklist apply (PERF-7 / DEC-52
// item 10), the contractor-link and item-contractor rules (MON-13 / DEC-76
// item 3), the project audit rows written under another type (SEC-21) and
// the contractor outcome notice's claim (SAF-9).
//
// There is no live database here: the migration is read as text — the
// one-paste protocol (DEC-30), the DRLS-16 rule for every function it adds,
// the byte-fidelity of the one object it RE-creates (audit_logs_admin_trail)
// against its NEWEST definition found by scanning the sequence at test
// time, and the parity of the SQL with the TypeScript it mirrors. The file
// was also run end to end on a throwaway PostgreSQL 16 cluster with a
// Supabase-shaped stub and the REAL 20261091 checklist rail and 20261142
// overlay (the records name the scenarios and their answers).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MACHINE_ACTOR_SWEEP, MACHINE_ACTOR_ASSESSMENT } from "@/lib/checklistEngine";
import { normalizeCurrency } from "@/lib/costDocs";
import { PER_ROW_CHUNK } from "@/lib/checklists";
import { normalizeCompanyName, barredCompanyFor } from "@/lib/bidTab";
import { summarizeAudit } from "@/lib/timeline";

const root = process.cwd();
const migDir = join(root, "supabase", "migrations");
const FILE = "20261157_prj_roundG_server_remainders.sql";
const mig = (f: string) => readFileSync(join(migDir, f), "utf8");
const M = mig(FILE);
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
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}
const fn = (name: string) => between(C, `CREATE OR REPLACE FUNCTION public.${name}(`, "\n$$;");

describe("the one-paste protocol (DEC-30)", () => {
  it("refuses to run before 20261142, then a TEMP inventory of COUNTs BEFORE the one transaction, and ONE final SELECT (check, ok, n)", () => {
    const guard = C.indexOf("Apply 20261142_prj_roundG_project_audit_rows.sql first");
    const temp = C.indexOf("CREATE TEMP TABLE prj_g_j12_inventory AS");
    const begin = C.indexOf("\nBEGIN;");
    const commit = C.indexOf("\nCOMMIT;");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(temp);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    expect(C.match(/\nBEGIN;/g)).toHaveLength(1);
    expect(C.match(/\nCOMMIT;/g)).toHaveLength(1);
    const tail = C.slice(commit);
    expect(tail).toMatch(/SELECT '[^']+' AS check,\s*\n\s*\([\s\S]*?\)[\s\S]*? AS ok,\s*\n\s*NULL::text AS n/);
    expect(tail.trimEnd().endsWith(";")).toBe(true);
    expect(tail.match(/;\s*$/gm)).toHaveLength(2); // "COMMIT;" and the one SELECT's end
    expect(tail).toMatch(/SELECT inventory, NULL::boolean, n FROM prj_g_j12_inventory;\s*$/);
    const inv = between(C, "CREATE TEMP TABLE prj_g_j12_inventory AS", "\nBEGIN;");
    // counts only, never rows
    for (const sel of inv.split(/UNION ALL/)) expect(sel, sel).toMatch(/COUNT\(\*\)::text/);
  });
  it("HOW TO APPLY says it is pasted only after the J12 code is deployed, and why (review minor: the old client's reasoned override would be refused)", () => {
    const how = between(M, "-- HOW TO APPLY:", "\nDO $$");
    expect(how).toContain("PASTE ORDER: after 20261142");
    expect(how).toContain("only\n-- once the J12 code is deployed");
    expect(how).toContain("it never sets\n-- app.cost_doc_award_override, so section 2 would refuse every reasoned\n-- override");
    // and the J12 code is what sets it: award_quote, with the lib calling it first
    expect(fn("award_quote")).toContain("PERFORM set_config('app.cost_doc_award_override', p_doc::text, true)");
    const lib = readFileSync(join(root, "lib/costDocs.ts"), "utf8");
    expect(lib).toContain('res = await supabase.rpc("award_quote", {');
  });
  it("is named in the package's reserved number and the sequence holds no other 20261157", () => {
    expect(numbered().filter((f) => f.startsWith("20261157"))).toEqual([FILE]);
  });
  it("the header's WHAT list uses the body's section numbers, 1 to 9, and the records cite those numbers (review minor)", () => {
    const body = [...M.matchAll(/^-- ── (\d+)\. /gm)].map((m) => Number(m[1]));
    expect(body).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const what = between(M, "-- WHAT:", "-- NOT a widening:");
    const labels = [...what.matchAll(/^--   (\d+)(?:–(\d+))?\. /gm)].flatMap((m) => {
      const a = Number(m[1]); const b = m[2] ? Number(m[2]) : a;
      return Array.from({ length: b - a + 1 }, (_, i) => a + i);
    });
    expect(labels).toEqual(body);
    const heading = (n: number) => M.match(new RegExp(`^-- ── ${n}\\. (.*)$`, "m"))![1];
    expect(heading(3)).toMatch(/GAP-406/);
    expect(heading(4)).toMatch(/PERF-7/);
    expect(heading(5)).toMatch(/MON-13/);
    const rec = (f: string) => readFileSync(join(root, "audit-reports", f), "utf8");
    expect(rec("projects-tab/90-gap-register.md")).toContain("`supabase/migrations/20261157_prj_roundG_server_remainders.sql` §3 `award_quote(");
    expect(rec("projects-tab/09-performance-scale.md")).toContain("`supabase/migrations/20261157_prj_roundG_server_remainders.sql` §4: `apply_checklist_item_writes(");
    expect(rec("projects-tab/03-money-ledger.md")).toContain("`supabase/migrations/20261157_prj_roundG_server_remainders.sql` §5 enforces DEC-76 item 3");
    expect(rec("projects-tab/03-money-ledger.md")).toContain("`supabase/migrations/20261157_prj_roundG_server_remainders.sql` §2: `enforce_cost_document_award_registry`");
    expect(rec("projects-tab/01-security-access.md")).toContain("`supabase/migrations/20261157_prj_roundG_server_remainders.sql` §6–7: `audit_row_project_ref_visible(");
    for (const f of ["projects-tab/90-gap-register.md", "projects-tab/09-performance-scale.md", "projects-tab/03-money-ledger.md"]) {
      expect(rec(f)).not.toMatch(/20261157_prj_roundG_server_remainders\.sql` §2 `award_quote|server_remainders\.sql` §3: `apply_checklist|server_remainders\.sql` §4 enforces/);
    }
  });
});

describe("DRLS-16 — every function this migration adds", () => {
  const added = [
    "cost_doc_company_behind", "company_name_key", "cost_doc_company_barred", "enforce_cost_document_award_registry", "award_quote",
    "apply_checklist_item_writes", "enforce_project_party_company_link", "enforce_quality_item_contractor",
    "audit_row_project_ref_visible", "enforce_intake_outcome_notice_server_only", "stamp_milestone_audit_project",
    "record_milestone_scope_on_delete",
  ];
  it("each is NEW — no earlier migration defines it (so there is no older body to start from)", () => {
    for (const f of numbered().filter((x) => x < FILE)) {
      const sql = code(mig(f));
      for (const name of added) expect(sql, `${f} defines ${name}`).not.toMatch(new RegExp(`FUNCTION\\s+(public\\.)?${name}\\s*\\(`));
    }
  });
  it("the three SECURITY DEFINERs (the registry rail, the milestone row's project stamp, the delete's scope row) are trigger functions, pin search_path and are revoked from PUBLIC, anon and authenticated", () => {
    const definers = [...C.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\([^)]*\)[\s\S]*?AS \$\$/g)].filter((m) => /SECURITY DEFINER/.test(m[0]));
    expect(definers.map((m) => m[1])).toEqual(["enforce_cost_document_award_registry", "stamp_milestone_audit_project", "record_milestone_scope_on_delete"]);
    for (const d of definers) {
      expect(d[0]).toMatch(/RETURNS trigger/);
      expect(d[0]).toMatch(/SECURITY DEFINER\s*\n\s*SET search_path = public/);
      for (const role of ["PUBLIC", "anon", "authenticated"]) {
        expect(C).toContain(`REVOKE ALL ON FUNCTION public.${d[1]}() FROM ${role};`);
      }
    }
  });
  it("the two RPCs a person calls refuse a NULL auth.uid(), are revoked from PUBLIC and anon, and granted to authenticated", () => {
    for (const [name, sig] of [["award_quote", "uuid, uuid, numeric, text, numeric"], ["apply_checklist_item_writes", "uuid, jsonb"]] as const) {
      const body = fn(name);
      expect(body).toMatch(/SECURITY INVOKER\s*\n\s*SET search_path = public/);
      expect(body).toMatch(/IF (v_uid|auth\.uid\(\)) IS NULL THEN\s*\n\s*RAISE EXCEPTION/);
      expect(C).toContain(`REVOKE ALL ON FUNCTION public.${name}(${sig}) FROM PUBLIC;`);
      expect(C).toContain(`REVOKE ALL ON FUNCTION public.${name}(${sig}) FROM anon;`);
      expect(C).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(${sig}) TO authenticated;`);
    }
  });
  it("the trigger functions keep the service pass (auth.uid() NULL) the Round G rails keep, and nobody may call them", () => {
    for (const name of ["enforce_cost_document_award_registry", "enforce_project_party_company_link", "enforce_quality_item_contractor", "enforce_intake_outcome_notice_server_only", "stamp_milestone_audit_project"]) {
      expect(fn(name)).toMatch(/RETURNS trigger/);
      expect(fn(name)).toContain("IF auth.uid() IS NULL THEN RETURN NEW; END IF;");
      expect(C).toContain(`REVOKE ALL ON FUNCTION public.${name}() FROM anon;`);
    }
    // the delete trigger's function passes the service role the same way, returning the row being deleted
    expect(fn("record_milestone_scope_on_delete")).toMatch(/RETURNS trigger/);
    expect(fn("record_milestone_scope_on_delete")).toContain("IF auth.uid() IS NULL THEN RETURN OLD; END IF;");
    expect(C).toContain("REVOKE ALL ON FUNCTION public.record_milestone_scope_on_delete() FROM anon;");
  });
});

describe("MON-12 — the registry rail on an award", () => {
  const rail = fn("enforce_cost_document_award_registry");
  it("fires BEFORE INSERT OR UPDATE OF status on cost_documents and judges only a move TO awarded", () => {
    expect(C).toMatch(/CREATE TRIGGER trg_cost_documents_award_registry\s*\n\s*BEFORE INSERT OR UPDATE OF status ON cost_documents/);
    expect(rail).toContain("IF NEW.status IS DISTINCT FROM 'awarded' THEN RETURN NEW; END IF;");
    expect(rail).toContain("IF TG_OP = 'UPDATE' AND OLD.status = 'awarded' THEN RETURN NEW; END IF;");
  });
  it("the write that awards a quote may not also move the link, the contractor or the vendor name it is judged by (review major)", () => {
    const guard = rail.indexOf("IF TG_OP = 'UPDATE' AND (NEW.party_id IS DISTINCT FROM OLD.party_id");
    expect(guard).toBeGreaterThan(rail.indexOf("IF TG_OP = 'UPDATE' AND OLD.status = 'awarded' THEN RETURN NEW; END IF;"));
    expect(guard).toBeLessThan(rail.indexOf("v_company := cost_doc_company_barred("));
    expect(rail).toContain("OR NEW.vendor_name IS DISTINCT FROM OLD.vendor_name");
    expect(rail).toContain("OR (to_jsonb(NEW) ->> 'company_id') IS DISTINCT FROM (to_jsonb(OLD) ->> 'company_id')) THEN");
    // award_quote's own claim changes status and its stamps only — it never trips the guard
    expect(fn("award_quote")).toContain("UPDATE cost_documents SET status = 'awarded', posted_at = now(), posted_by = v_uid\n");
    // and so does the lib's client-sequence claim
    const lib = readFileSync(join(root, "lib/costDocs.ts"), "utf8");
    expect(lib).toContain("? { status: to, posted_at: new Date().toISOString(), posted_by: actorUid }");
  });
  it("a link counts only to a company of the document's own org — the rail reads as the definer, past every org's RLS (review major)", () => {
    const behind = fn("cost_doc_company_behind");
    expect(behind).toContain("FROM companies c WHERE c.id = p_company AND c.org_id = p_org;");
    expect(behind).toContain("FROM companies c WHERE c.id = v_party_company AND c.org_id = p_org;");
    const lib = readFileSync(join(root, "lib/costDocs.ts"), "utf8");
    expect(between(lib, "async function companyBehind(", "\n}\n")).toContain('.eq("id", id).eq("org_id", doc.orgId).maybeSingle()');
  });
  it("refuses a do-not-use or inactive company unless award_quote set the override for THIS document", () => {
    expect(rail).toMatch(/v_company ->> 'status' IN \('do_not_use', 'inactive'\)\s*\n\s*AND COALESCE\(current_setting\('app\.cost_doc_award_override', true\), ''\) IS DISTINCT FROM NEW\.id::text/);
    expect(rail).toMatch(/USING ERRCODE = 'check_violation'/);
    // the company column of 20261096 is read through to_jsonb — a database without it is not broken
    expect(rail).toContain("NULLIF(to_jsonb(NEW) ->> 'company_id', '')::uuid");
  });
  it("resolves the company as lib/costDocs.ts companyBehind does: the document's link, then the contractor's, then ONE exact name", () => {
    const behind = fn("cost_doc_company_behind");
    const doc = behind.indexOf("FROM companies c WHERE c.id = p_company");
    const party = behind.indexOf("FROM project_parties pp WHERE pp.id = p_party");
    const name = behind.indexOf("lower(c.name) = lower(btrim(p_vendor))");
    expect(doc).toBeGreaterThan(0);
    expect(doc).toBeLessThan(party);
    expect(party).toBeLessThan(name);
    expect(behind).toContain("IF v_n <> 1 THEN RETURN NULL; END IF;");
    expect(behind).toMatch(/SECURITY INVOKER/);
    const lib = readFileSync(join(root, "lib/costDocs.ts"), "utf8");
    const ts = between(lib, "async function companyBehind(", "\n}\n");
    expect(ts.indexOf("raw.company_id")).toBeLessThan(ts.indexOf("project_parties"));
    expect(ts.indexOf("project_parties")).toBeLessThan(ts.indexOf(".ilike(\"name\""));
    expect(ts).toContain("rows.length === 1");
  });
  it("the rail judges the GATE, not the binding: a bid with no own link answers for ANY do-not-use row its name normalises to, else for the company it binds to (review major; review fixes 4 and 5)", () => {
    expect(rail).toContain("v_company := cost_doc_company_barred(NEW.org_id, NULLIF(to_jsonb(NEW) ->> 'company_id', '')::uuid, NEW.party_id, NEW.vendor_name);");
    expect(rail).not.toContain("cost_doc_company_behind(");
    const gate = fn("cost_doc_company_barred");
    expect(gate).toMatch(/LANGUAGE plpgsql STABLE\s*\n\s*SECURITY INVOKER\s*\n\s*SET search_path = public/);
    // the document's own link decides, flagged or not; the contractor's answers only when its company is
    // flagged (review fix 5: an ACTIVE contractor link — which the intake door picks by name — never hides
    // a do-not-use look-alike); each only to a company of the org
    const own = gate.indexOf("FROM companies c WHERE c.id = p_company AND c.org_id = p_org;");
    const party = gate.indexOf("FROM companies c WHERE c.id = v_party_company AND c.org_id = p_org;");
    const partyFlag = gate.indexOf("IF v_row ->> 'status' IN ('do_not_use', 'inactive') THEN RETURN v_row; END IF;");
    const names = gate.indexOf("v_key := company_name_key(p_vendor);");
    expect(own).toBeGreaterThan(0);
    expect(own).toBeLessThan(party);
    expect(party).toBeLessThan(partyFlag);
    expect(partyFlag).toBeLessThan(names);
    expect(gate.slice(party, names)).not.toContain("RETURN CASE");
    // the own link answers for its own flag, do_not_use or inactive; so does the bound company, last
    expect(gate.split("RETURN CASE WHEN v_row ->> 'status' IN ('do_not_use', 'inactive') THEN v_row END;").length - 1).toBe(2);
    // no link: ANY do_not_use row of the org with the same key — no uniqueness, the exact name first (DEC-48's
    // gate flags do-not-use look-alikes only, as barredCompanyFor does — review fix 4: an INACTIVE look-alike
    // the quote does not bind to is not the bid's)
    expect(gate).toContain("IF v_key <> '' THEN\n    SELECT jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status) INTO v_row\n      FROM companies c\n     WHERE c.org_id = p_org AND c.status = 'do_not_use'\n       AND company_name_key(c.name) = v_key\n     ORDER BY (lower(c.name) = lower(btrim(p_vendor))) DESC NULLS LAST, c.id\n     LIMIT 1;\n    IF v_row IS NOT NULL THEN RETURN v_row; END IF;\n  END IF;");
    expect(gate).not.toContain("c.status IN (");
    expect(gate).not.toMatch(/COUNT\(\*\)|v_n <> 1/);
    // else the company the quote binds to (cost_doc_company_behind with no own link: the contractor's link,
    // else one exact name), on its own flag — an active contractor company answers null, as the award records it
    const bound = gate.indexOf("v_row := cost_doc_company_behind(p_org, NULL, p_party, p_vendor);\n  RETURN CASE WHEN v_row ->> 'status' IN ('do_not_use', 'inactive') THEN v_row END;\nEND;");
    expect(bound).toBeGreaterThan(gate.indexOf("IF v_row IS NOT NULL THEN RETURN v_row; END IF;"));
    // the lib's gate is the same rule: barredCompanyFor's candidates, the link deciding
    const lib = readFileSync(join(root, "lib/costDocs.ts"), "utf8");
    const look = between(lib, "async function flaggedLookAlike(", "\n}\n");
    expect(look).toContain("const key = normalizeCompanyName(vendorName);");
    expect(look).toContain('.eq("status", "do_not_use")');
    expect(look).not.toContain("FLAGGED_COMPANY_STATUSES");
    expect(look).toContain("Number(b.name.toLowerCase() === exact) - Number(a.name.toLowerCase() === exact) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)");
    expect(look).toContain("hits.push(...rows.filter((c) => normalizeCompanyName(c.name) === key));");
    expect(look).toContain("if (rows.length < 1000) break;");
    expect(lib).toContain('const FLAGGED_COMPANY_STATUSES = ["do_not_use", "inactive"];');
    const behind = between(lib, "async function companyBehind(", "\n}\n");
    expect(behind).toContain("if (hit.company) return { company: hit.company, barred: flaggedOrNull(hit.company) };");
    expect(behind.split("if (hit.company) return { company: hit.company, barred: flaggedOrNull(hit.company) };").length - 1).toBe(1); // the own link only
    // the contractor's link: its flagged company answers; an unflagged one binds and the look-alike gate still runs
    const partyTs = behind.slice(behind.indexOf('from("project_parties")'), behind.indexOf("const name = doc.vendorName?.trim();"));
    expect(partyTs).toContain("if (flagged) return { company: hit.company, barred: flagged };");
    expect(partyTs).toContain('const lookAlike = await flaggedLookAlike(doc.orgId, doc.vendorName ?? "");');
    expect(partyTs).toContain("return { company: hit.company, barred: lookAlike.company };");
    expect(behind.split('const lookAlike = await flaggedLookAlike(doc.orgId, doc.vendorName ?? "");').length - 1).toBe(2);
    expect(behind).toContain("if (lookAlike.error) return { company: null, barred: null, error: lookAlike.error };");
    expect(behind).toContain("return { company: bound, barred: lookAlike.company ?? (bound ? flaggedOrNull(bound) : null) };");
    // the bid tab's chip reads the document's own link only (QuotesPanel registryFor) — a quote filed against a
    // contractor whose company is active still answers for the look-alike there, by the vendor name on file;
    // its award prompt asks the database's own gate (companyAwardAnswersFor, J12 review fix 7 — below), and
    // before 20261157 the same look-alike gate over the stored name
    const panel = readFileSync(join(root, "components/projects/cost/QuotesPanel.tsx"), "utf8");
    expect(panel).toContain("const onFile = barredCompanyFor(doc.vendorName, null, flags);");
    expect(panel).toContain("const hit = barredCompanyFor(bid.vendorName, null, await barredRows());");
    expect(between(panel, "const registryFor = (", "\n  };")).not.toMatch(/partyId|project_parties/);
    // and the intake door picks that contractor by name, with nobody choosing (review fix 5's case)
    const door = readFileSync(join(root, "app/api/intake/upload/route.ts"), "utf8");
    expect(door).toContain("partyId = matchCompanyByName(company, named)?.id ?? null;");
    // the bid tab's own gate: a do-not-use look-alike flags, an inactive one does not (review fix 4's parity)
    const reg = [{ id: "a", name: "Harbor Welding", status: "active" }, { id: "old", name: "Harbor Welding, Inc.", status: "inactive" }];
    expect(barredCompanyFor("Harbor Welding", null, reg)).toBeNull();
    expect(barredCompanyFor("Harbor Welding", null, [...reg, { id: "dnu", name: "Harbor Welding LLC", status: "do_not_use" }])?.id).toBe("dnu");
  });
  it("J12 review fix 7: the bid tab's award prompt asks cost_doc_company_barred itself — award_quote's four arguments, read from the row as stored, never the letterhead — and authenticated may EXECUTE it", () => {
    // the grant and the invoker rights the panel's call relies on (the same caller, the same RLS as award_quote)
    expect(C).toContain("GRANT EXECUTE ON FUNCTION public.cost_doc_company_barred(uuid, uuid, uuid, text) TO authenticated, service_role;");
    expect(C).toContain("REVOKE ALL ON FUNCTION public.cost_doc_company_barred(uuid, uuid, uuid, text) FROM anon;");
    expect(fn("cost_doc_company_barred")).toMatch(/LANGUAGE plpgsql STABLE\s*\n\s*SECURITY INVOKER/);
    expect(fn("award_quote")).toContain("v_barred := cost_doc_company_barred(v_doc.org_id, NULLIF(v_raw ->> 'company_id', '')::uuid, v_doc.party_id, v_doc.vendor_name);");
    const panel = readFileSync(join(root, "components/projects/cost/QuotesPanel.tsx"), "utf8");
    // the row as re-read at the click (awardGateFor) — its stored fields are the database question's arguments
    const gate = between(panel, "export async function awardGateFor(", "\n}\n");
    expect(gate).toContain('await supabase.from("cost_documents").select("*").eq("id", doc.id).maybeSingle();');
    expect(gate).toContain("const orgId = text(raw?.org_id) ?? doc.orgId;");
    expect(gate).toContain("const companyId = text(raw?.company_id);");
    expect(gate).toContain("const partyId = raw ? text(raw.party_id) : doc.partyId;");
    expect(gate).toContain("const vendorName = raw ? text(raw.vendor_name) : doc.vendorName;");
    expect(gate).toContain("const override = await companyAwardAnswersFor({ orgId, companyId, partyId, vendorName }, linkedCompany, barredRows);");
    const ask = between(panel, "export async function companyAwardAnswersFor(", "\n}\n");
    expect(ask).toContain('supabase.rpc("cost_doc_company_barred", {\n    p_org: bid.orgId, p_company: bid.companyId, p_party: bid.partyId, p_vendor: bid.vendorName,\n  });');
    // the database's question never reads the letterhead (J12 review fix pass 8 keeps fix 7's rule) ...
    expect(ask).not.toMatch(/parsedQuoteFrom|\.parsed\b|e\??\.vendorName|letterhead/);
    // only an absent function falls back (the lib's own test for its client sequence); any other error stops the award
    expect(ask).toContain("if (!isMissingRpc(rpcErr)) throw new Error(userFacingReadError(rpcErr));");
    const award = between(panel, "const award = async (", "\n  };\n");
    expect(award).toContain("return await awardGateFor(doc);");
    expect(award).not.toContain("e?.vendorName ?? doc.vendorName");
    expect(award).toContain("const failed = await recordIntent(held.override, overrideReason, held.override.status);");
    // ... and the letterhead's stop (fix pass 8) is its own audit action, never the override's reason
    expect(award).toContain('action: "COST_DOC_AWARD_LETTERHEAD_ACK", resource_type: "cost", resource_id: doc.id,');
    expect(award.match(/await awardQuote\(\{[^}]*\}\)/g)).toEqual([
      "await awardQuote({ doc, siblings, costAccountId: accountId, actor, overrideReason, confirmedTotal })",
      "await awardQuote({ doc, siblings, costAccountId: accountId, actor, overrideReason: reason, confirmedTotal })",
    ]);
  });
  it("two non-exact do-not-use look-alikes: the lib and the database break the tie the same way — the exact name first, then the id in byte order, no collation in either (review fix 5 minor)", () => {
    const gate = fn("cost_doc_company_barred");
    const order = gate.slice(gate.indexOf("ORDER BY"), gate.indexOf("LIMIT 1;"));
    expect(order.trim()).toBe("ORDER BY (lower(c.name) = lower(btrim(p_vendor))) DESC NULLS LAST, c.id");
    expect(order).not.toContain("c.name,");
    const lib = readFileSync(join(root, "lib/costDocs.ts"), "utf8");
    const look = between(lib, "async function flaggedLookAlike(", "\n}\n");
    expect(look).not.toContain("localeCompare");
    // the exact name as btrim reads it: spaces only (JS trim() also strips tabs and newlines)
    expect(look).toContain('const exact = vendorName.replace(/^ +| +$/g, "").toLowerCase();');
    expect(look).not.toContain("vendorName.trim()");
    // and the lib hands it the vendor name as stored, not a JS-trimmed copy
    expect(between(lib, "async function companyBehind(", "\n}\n")).not.toContain("flaggedLookAlike(doc.orgId, name)");
    // byte order of the canonical (lower-case) uuid text is uuid order — PostgreSQL compares uuids as bytes
    const ids = ["00000000-0000-0000-0000-0000000005d2", "00000000-0000-0000-0000-0000000005d1", "0000000a-0000-0000-0000-000000000000", "00000009-ffff-ffff-ffff-ffffffffffff"];
    expect([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([
      "00000000-0000-0000-0000-0000000005d1", "00000000-0000-0000-0000-0000000005d2", "00000009-ffff-ffff-ffff-ffffffffffff", "0000000a-0000-0000-0000-000000000000",
    ]);
  });
  it("company_name_key is lib/bidTab.ts normalizeCompanyName in SQL: the same suffix list in the same order, the same steps, the same answers", () => {
    const key = fn("company_name_key");
    expect(key).toMatch(/LANGUAGE plpgsql IMMUTABLE\s*\n\s*SECURITY INVOKER\s*\n\s*SET search_path = public/);
    const ts = readFileSync(join(root, "lib/bidTab.ts"), "utf8");
    const tsSet = between(ts, "const LEGAL_SUFFIXES = new Set([", "]);");
    const tsList = [...tsSet.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    const sqlArr = between(key, "v_suffixes CONSTANT text[] := ARRAY[", "];");
    const sqlList = [...sqlArr.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(tsList.length).toBeGreaterThan(10);
    expect(sqlList).toEqual(tsList);
    // the steps, as written in the TypeScript
    expect(ts).toContain('const tokens = s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").split(/\\s+/).filter(Boolean);');
    expect(ts).toContain("while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();");
    expect(ts).toContain('if (tokens.length > 1 && tokens[0] === "the") tokens.shift();');
    expect(ts).toContain('return tokens.join(" ");');
    expect(key).toContain("regexp_replace(replace(lower(COALESCE(p_name, '')), '&', ' and '), '[^a-z0-9 ]+', ' ', 'g'), ' +'), '');");
    expect(key).toContain("v_tokens := array_remove(regexp_split_to_array(");
    expect(key).toContain("WHILE cardinality(v_tokens) > 1 AND v_tokens[cardinality(v_tokens)] = ANY (v_suffixes) LOOP\n    v_tokens := v_tokens[1:cardinality(v_tokens) - 1];\n  END LOOP;");
    expect(key).toContain("IF cardinality(v_tokens) > 1 AND v_tokens[1] = 'the' THEN\n    v_tokens := v_tokens[2:cardinality(v_tokens)];\n  END IF;");
    expect(key).toContain("RETURN array_to_string(v_tokens, ' ');");
    // A literal mirror of the SQL steps (an array, the suffix list read from the SQL) agrees with the TypeScript
    // on these vectors; the same vectors, with these answers, were run through company_name_key on the scratch
    // PostgreSQL 16 (records: MON-12) and the final SELECT re-checks six of them on paste.
    const sqlMirror = (name: string | null): string => {
      let t = (name ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").split(/ +/).filter((x) => x !== "");
      while (t.length > 1 && sqlList.includes(t[t.length - 1])) t = t.slice(0, -1);
      if (t.length > 1 && t[0] === "the") t = t.slice(1);
      return t.join(" ");
    };
    const vectors: Array<[string, string]> = [
      ["Gulf Mechanical, Inc.", "gulf mechanical"], ["Gulf Mechanical Inc", "gulf mechanical"], ["  gulf   MECHANICAL inc ", "gulf mechanical"],
      ["GULF MECHANICAL, INC.", "gulf mechanical"], ["Gulf Mechanical Co. Ltd.", "gulf mechanical"], ["The Smith & Sons Co.", "smith and sons"],
      ["Smith and Sons", "smith and sons"], ["A&B Welding LLC", "a and b welding"], ["The", "the"], ["Inc.", "inc"], ["The Inc", "the"],
      ["Co Co", "co"], ["Apex Industrial Services, LLC", "apex industrial services"], ["Apex Industrial", "apex industrial"],
      ["Bayline Piping, L.L.C.", "bayline piping l l c"], ["O'Brien Electric Pty Ltd", "o brien electric"], ["3M Company", "3m"],
      ["Müller GmbH", "m ller"], ["", ""], ["   ", ""], ["---", ""], ["The The Company", "the"], ["Acme   Holdings  PLC", "acme holdings"],
      ["Delta-Tech S.A.", "delta tech s a"], ["Delta Tech SA", "delta tech"], ["Northwind, Inc. (USA)", "northwind inc usa"],
    ];
    for (const [name, want] of vectors) {
      expect(normalizeCompanyName(name), name).toBe(want);
      expect(sqlMirror(name), name).toBe(want);
    }
    const probe = C.slice(C.indexOf("\nCOMMIT;"));
    for (const [name, want] of [["Gulf Mechanical, Inc.", "gulf mechanical"], ["The Smith & Sons Co.", "smith and sons"], ["Apex Industrial Services, LLC", "apex industrial services"]]) {
      expect(probe).toContain(`company_name_key('${name}') = '${want}'`);
      expect(normalizeCompanyName(name)).toBe(want);
    }
    // the gate's answer for the review's case, in the TypeScript the bid tab runs
    const registry = [{ id: "dnu", name: "Gulf Mechanical, Inc.", status: "do_not_use" }];
    expect(barredCompanyFor("Gulf Mechanical Inc", null, registry)?.id).toBe("dnu");
  });
  it("award_quote gates on the same rule and records the binding: the refusal and the override name the flagged company, COST_DOC_AWARDED the bound one", () => {
    const rpc = fn("award_quote");
    expect(rpc).toContain("v_company := cost_doc_company_behind(v_doc.org_id, NULLIF(v_raw ->> 'company_id', '')::uuid, v_doc.party_id, v_doc.vendor_name);");
    expect(rpc).toContain("v_barred := cost_doc_company_barred(v_doc.org_id, NULLIF(v_raw ->> 'company_id', '')::uuid, v_doc.party_id, v_doc.vendor_name);");
    expect(rpc).toContain("v_flagged := v_barred IS NOT NULL AND v_barred ->> 'status' IN ('do_not_use', 'inactive');");
    expect(rpc).toContain("jsonb_build_object('companyId', v_barred ->> 'id', 'companyName', v_barred ->> 'name',");
    expect(rpc).toContain("'companyId', v_company ->> 'id', 'override', CASE WHEN v_flagged THEN v_override END,");
    const lib = readFileSync(join(root, "lib/costDocs.ts"), "utf8");
    expect(lib).toContain("companyId: barredCompany.id, companyName: barredCompany.name, companyStatus: barredCompany.status, reason: override,");
    expect(lib).toContain("companyId: awardedCompany?.id ?? null, override,");
  });
});

describe("GAP-406 — the award as one transaction", () => {
  const rpc = fn("award_quote");
  it("locks the quote, refuses before the claim with RETURN (nothing written), and RAISES after it (the award rolls back whole)", () => {
    const lock = rpc.indexOf("SELECT * INTO v_doc FROM cost_documents WHERE id = p_doc FOR UPDATE;");
    const claim = rpc.indexOf("UPDATE cost_documents SET status = 'awarded', posted_at = now(), posted_by = v_uid");
    const entry = rpc.indexOf("INSERT INTO cost_entries");
    const posted = rpc.indexOf("'COST_ENTRY_POSTED'");
    const override = rpc.indexOf("'COST_DOC_AWARD_OVERRIDE'");
    const decline = rpc.indexOf("UPDATE cost_documents SET status = 'declined'");
    const awarded = rpc.indexOf("'COST_DOC_AWARDED'");
    expect(lock).toBeGreaterThan(0);
    for (const [a, b] of [[lock, claim], [claim, entry], [entry, posted], [posted, override], [override, decline], [decline, awarded]]) expect(a).toBeLessThan(b);
    // every `ok: false` answer comes before any write
    const lastRefusal = rpc.lastIndexOf("jsonb_build_object('ok', false");
    expect(lastRefusal).toBeLessThan(entry);
    expect(rpc.slice(rpc.indexOf("GET DIAGNOSTICS v_claimed"), rpc.indexOf("GET DIAGNOSTICS v_claimed") + 300)).toContain("IF v_claimed = 0 THEN RETURN jsonb_build_object('ok', false, 'code', 'refused'); END IF;");
  });
  it("re-checks under the lock what the lib's guard checked: status, the budget line's project and currency, the total, the registry", () => {
    expect(rpc).toContain("IF v_doc.status NOT IN ('draft', 'parsed') THEN");
    expect(rpc).toContain("v_account.project_id IS DISTINCT FROM v_doc.project_id");
    expect(rpc).toContain("IF p_expected_total IS NULL OR v_total <> p_expected_total THEN");
    expect(rpc).toContain("RETURN jsonb_build_object('ok', false, 'code', 'company_flagged', 'company', v_barred);");
    expect(rpc).toContain("IF v_flagged THEN PERFORM set_config('app.cost_doc_award_override', p_doc::text, true); END IF;");
    expect(rpc).toContain("PERFORM set_config('app.cost_doc_award_override', '', true);");
  });
  it("re-checks COST-13 under the lock before the claim: a confirmed figure that is not the total, an AI total from a truncated or unknown read with none (review minor)", () => {
    const mismatch = rpc.indexOf("IF p_confirmed_total IS NOT NULL AND round(p_confirmed_total) <> round(v_total) THEN");
    const extent = rpc.indexOf("IF p_confirmed_total IS NULL AND v_extracted IS NOT NULL AND (v_raw ? 'pages_read' OR v_raw ? 'pages_total') THEN");
    const claim = rpc.indexOf("UPDATE cost_documents SET status = 'awarded'");
    expect(mismatch).toBeGreaterThan(rpc.indexOf("'code', 'company_flagged'"));
    expect(mismatch).toBeLessThan(extent);
    expect(extent).toBeLessThan(claim);
    expect(rpc).toContain("RETURN jsonb_build_object('ok', false, 'code', 'confirm_mismatch', 'total', v_total, 'confirmed', p_confirmed_total);");
    expect(rpc).toContain("IF v_pages_read IS NULL OR v_pages_total IS NULL OR v_pages_read < v_pages_total THEN");
    expect(rpc).toContain("RETURN jsonb_build_object('ok', false, 'code', 'extent', 'total', v_total, 'pagesRead', v_pages_read, 'pagesTotal', v_pages_total);");
    // the lib's extentRefusal is the same rule, and the codes read as its sentences
    const lib = readFileSync(join(root, "lib/costDocs.ts"), "utf8");
    const er = between(lib, "function extentRefusal(", "\n}\n");
    expect(er).toContain("Math.round(confirmedTotal) !== Math.round(total)");
    expect(er).toContain("if (extracted == null) return null;");
    expect(er).toContain("if (!ext.recorded) return null;");
    expect(er).toContain("return extentMessage(ext.pagesRead, ext.pagesTotal, total);");
    expect(lib).toContain('case "confirm_mismatch":\n        return { ok: false, error: confirmMismatchMessage(');
    expect(lib).toContain('case "extent":\n        return { ok: false, error: extentMessage(');
  });
  it("normalises a currency as lib/costDocs.ts normalizeCurrency does ($ / US$ / USD$ / $US are USD; else three letters or unknown)", () => {
    expect(rpc).toContain("IN ('$', 'US$', 'USD$', '$US') THEN 'USD'");
    for (const s of ["$", "US$", "USD$", "$US"]) expect(normalizeCurrency(s)).toBe("USD");
    expect(normalizeCurrency(" eur ")).toBe("EUR");
    expect(normalizeCurrency("dollars")).toBeNull();
  });
  it("posts lib/costs.ts addEntry's row (commitment, today in UTC, the award description, the reference, the source document)", () => {
    expect(rpc).toMatch(/'commitment', v_total,\s*\n\s*\(now\(\) AT TIME ZONE 'UTC'\)::date/);
    expect(rpc).toContain("btrim('Award — ' || COALESCE(v_doc.vendor_name, 'vendor')");
    expect(rpc).toContain("NULLIF(btrim(COALESCE(v_doc.doc_number, v_doc.file_name, '')), '')");
    const lib = readFileSync(join(root, "lib/costDocs.ts"), "utf8");
    expect(lib).toContain("description: `Award — ${fresh.vendorName ?? \"vendor\"}${fresh.rfqGroup ? ` (${fresh.rfqGroup})` : \"\"}`");
  });
  it("declines rivals by the RFQ group KEY (case-folded, whitespace collapsed) — the bid tab's rfqGroupKey", () => {
    expect(rpc).toContain("v_key := lower(btrim(regexp_replace(COALESCE(v_doc.rfq_group, ''), '\\s+', ' ', 'g')));");
    expect(rpc).toContain("AND lower(btrim(regexp_replace(COALESCE(c.rfq_group, ''), '\\s+', ' ', 'g'))) = v_key;");
  });
});

describe("PERF-7 — the machine's writes in one request, the per-row updated_at guard kept", () => {
  const rpc = fn("apply_checklist_item_writes");
  it("applies the whole call in ONE guarded statement first — one sub-transaction, the guard on every row (review minor: subtransaction cache)", () => {
    const set = rpc.indexOf("UPDATE checklist_items ci SET");
    const loop = rpc.indexOf("FOR v_write IN SELECT value FROM jsonb_array_elements(v_valid) LOOP");
    expect(set).toBeGreaterThan(0);
    expect(set).toBeLessThan(loop);
    const stmt = rpc.slice(set, rpc.indexOf("RETURNING ci.id", set));
    expect(stmt).toContain("FROM w");
    expect(stmt).toContain("AND ci.checklist_id = p_checklist");
    expect(stmt).toContain("AND ci.updated_at IS NOT DISTINCT FROM NULLIF(w.v ->> 'expected_updated_at', '')::timestamptz");
    // a refused statement leaves nothing standing, and is re-judged — never returned as an outcome
    expect(rpc).toMatch(/EXCEPTION WHEN OTHERS THEN\s*\n\s*v_landed := '\[\]'::jsonb;[^\n]*\n\s*v_refused := '\[\]'::jsonb;\s*\n\s*END;/);
    // two writes to one item go row by row (the first lands, the second meets its guard)
    expect(rpc).toContain("IF NOT v_dupes AND jsonb_array_length(v_valid) > 0 THEN");
  });
  it("judges row by row only a call of at most PER_ROW_CHUNK; a larger refused call applies nothing and answers split", () => {
    expect(PER_ROW_CHUNK).toBe(50);
    expect(PER_ROW_CHUNK).toBeLessThanOrEqual(64);
    const cap = rpc.indexOf(`IF jsonb_array_length(v_valid) > ${PER_ROW_CHUNK} THEN`);
    expect(cap).toBeGreaterThan(rpc.indexOf("EXCEPTION WHEN OTHERS THEN"));
    expect(cap).toBeLessThan(rpc.indexOf("FOR v_write IN SELECT value FROM jsonb_array_elements(v_valid) LOOP"));
    expect(rpc).toContain(`RETURN jsonb_build_object('landed', '[]'::jsonb, 'refused', '[]'::jsonb, 'failed', '[]'::jsonb, 'split', ${PER_ROW_CHUNK});`);
    const lib = readFileSync(join(root, "lib/checklists.ts"), "utf8");
    expect(lib).toContain("if (part?.split && call.length > 1) {");
  });
  it("the row-by-row path keeps the per-row guard and one sub-transaction per row", () => {
    expect(rpc).toContain("AND ci.updated_at IS NOT DISTINCT FROM NULLIF(v_write ->> 'expected_updated_at', '')::timestamptz");
    expect(rpc).toMatch(/BEGIN\s*\n\s*v_id := \(v_write ->> 'id'\)::uuid;[\s\S]*EXCEPTION WHEN OTHERS THEN/);
    expect(rpc).toContain("RETURN jsonb_build_object('landed', v_landed, 'refused', v_refused, 'failed', v_failed);");
  });
  it("checks every write up front (an item id, a machine name), writes only the machine actor's columns, stamps updated_by NULL itself", () => {
    expect(rpc.split(`IN ('${MACHINE_ACTOR_SWEEP}', '${MACHINE_ACTOR_ASSESSMENT}')`).length - 1).toBeGreaterThanOrEqual(2);
    expect(rpc).toContain("'message', 'Only the evidence sweep and the AI assessment write through this call — a person''s decision is its own write; nothing was changed.')");
    for (const col of ["status", "applicability", "ai_rationale", "evidence"]) {
      expect(rpc).toContain(`${col} = CASE WHEN w.v ? '${col}'`);
      expect(rpc).toContain(`${col} = CASE WHEN v_write ? '${col}'`);
    }
    expect(rpc.match(/updated_by = NULL,/g)).toHaveLength(2);
    expect(rpc).not.toMatch(/manual_note\s*=/);
  });
});

describe("MON-13 — the contractor link is set once; a decided item keeps its contractor", () => {
  it("a set company link is never re-pointed or cleared by a signed-in caller; the company's own delete (FK SET NULL, one level down) passes", () => {
    const f = fn("enforce_project_party_company_link");
    expect(C).toMatch(/CREATE TRIGGER trg_project_parties_company_link\s*\n\s*BEFORE UPDATE OF company_id ON project_parties/);
    expect(f).toContain("IF OLD.company_id IS NULL OR NEW.company_id IS NOT DISTINCT FROM OLD.company_id THEN RETURN NEW; END IF;");
    expect(f).toContain("IF NEW.company_id IS NULL AND pg_trigger_depth() > 1 THEN RETURN NEW; END IF;");
  });
  it("an item's contractor moves only while it is undecided (lib/turnover.ts assignContractor's rule), never names a rejected turnover item", () => {
    const f = fn("enforce_quality_item_contractor");
    expect(C).toMatch(/CREATE TRIGGER trg_turnover_items_contractor_fixed\s*\n\s*BEFORE UPDATE OF party_id ON turnover_items/);
    expect(C).toMatch(/CREATE TRIGGER trg_punch_items_contractor_fixed\s*\n\s*BEFORE UPDATE OF party_id ON punch_items/);
    expect(f).toContain("(TG_TABLE_NAME = 'turnover_items' AND OLD.status IN ('open', 'received'))");
    expect(f).toContain("(TG_TABLE_NAME = 'punch_items' AND OLD.status = 'open')");
    expect(f).toContain("IF TG_TABLE_NAME = 'turnover_items' AND OLD.status = 'rejected' THEN");
    const lib = readFileSync(join(root, "lib/turnover.ts"), "utf8");
    expect(lib).toContain('undecided: input.item.status === "open" || input.item.status === "received"');
    expect(lib).toContain('undecided: input.item.status === "open",');
  });
});

describe("SEC-21 — audit_logs_admin_trail re-created from its NEWEST definition + ONE clause", () => {
  const definers = () => numbered().filter((f) => /CREATE POLICY audit_logs_admin_trail/.test(mig(f)));
  it("the newest earlier definition is found by scanning the sequence (today 20261142), and this file is the newest of all", () => {
    const ds = definers();
    expect(ds[ds.length - 1]).toBe(FILE);
    expect(ds[ds.length - 2]).toBe("20261142_prj_roundG_project_audit_rows.sql");
  });
  it("lineDiff: nothing of the newest earlier body is lost; only the SEC-21 comment and its clause are added", () => {
    const ds = definers();
    const prev = mig(ds[ds.length - 2]);
    const live = between(prev, "DROP POLICY IF EXISTS audit_logs_admin_trail ON audit_logs;", "\n  );");
    const next = between(M, "DROP POLICY IF EXISTS audit_logs_admin_trail ON audit_logs;", "\n  );");
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual([]);
    expect(onlyInB.filter((l) => !/^\s*--/.test(l))).toEqual([
      "    AND ((COALESCE(resource_type, '') <> 'project_intake_link'",
      "          AND left(COALESCE(action, ''), 10) <> 'MILESTONE_'",
      "          AND left(COALESCE(action, ''), 7) <> 'INTAKE_')",
      "         OR audit_row_project_ref_visible(action, resource_type, resource_id, details))",
    ]);
    expect(onlyInB.filter((l) => /^\s*--/.test(l)).length).toBeGreaterThan(0);
    expect(next).toMatch(/AS RESTRICTIVE FOR SELECT\s*\n\s*USING \(/);
    expect(next).not.toMatch(/\bTO\b\s+(anon|authenticated|public)/i);
  });
  it("the function's kinds and the policy's inline test agree, and it reads only what the caller may read (SECURITY INVOKER, no SET clause, names qualified)", () => {
    const f = between(C, "CREATE OR REPLACE FUNCTION public.audit_row_project_ref_visible(", "\n$$;");
    expect(f).toMatch(/RETURNS boolean LANGUAGE sql STABLE AS \$\$/);
    expect(f).not.toMatch(/SECURITY DEFINER|SET search_path/);
    expect(f).toContain("WHEN p_type = 'project_intake_link' THEN");
    expect(f).toContain("WHEN left(COALESCE(p_action, ''), 10) = 'MILESTONE_' THEN");
    expect(f).toContain("public.project_visible_to_me((p_details ->> 'projectId')::uuid)");
    expect(f).toContain("FROM public.project_intake_links l");
    expect(f).toContain("FROM public.milestones m");
    // the MILESTONE_ and INTAKE_ prefixes are the audit vocabulary the app writes
    const audit = readFileSync(join(root, "lib/audit.ts"), "utf8");
    expect(audit).toMatch(/"MILESTONE_CREATED"/);
    expect(audit).toContain("milestoneId: params.milestoneId");
  });
  it("a gone (or unreadable) milestone's row stays readable when it is typed milestone (org-level); a document-typed one is the audit roles' (review minor)", () => {
    const f = between(C, "CREATE OR REPLACE FUNCTION public.audit_row_project_ref_visible(", "\n$$;");
    const found = f.indexOf("AND EXISTS (SELECT 1 FROM public.milestones m WHERE m.id = (p_details ->> 'milestoneId')::uuid)");
    const orgLevel = f.indexOf("WHEN p_type = 'milestone' THEN true");
    expect(found).toBeGreaterThan(0);
    expect(orgLevel).toBeGreaterThan(found);
    expect(f.slice(orgLevel)).toMatch(/^WHEN p_type = 'milestone' THEN true\s*\n\s*WHEN p_details @> '\{"projectIdFrom": "milestone", "orgLevel": true\}'::jsonb THEN true\s*\n\s*ELSE false END/);
    // lib/milestones.ts writes 'milestone' only for a milestone on no project and no document
    const ms = readFileSync(join(root, "lib/milestones.ts"), "utf8");
    expect(ms).toMatch(/function pickResource\(/);
    expect(C).toContain("audit_row_project_ref_visible('MILESTONE_DELETED', 'milestone', '00000000-0000-0000-0000-000000000000', '{\"milestoneId\":\"00000000-0000-0000-0000-000000000000\"}'::jsonb)");
  });
  it("section 9: a milestone row is stamped with its project as it is written, so the first branch decides it after the milestone is deleted (review minor)", () => {
    const f = fn("stamp_milestone_audit_project");
    expect(C).toMatch(/CREATE TRIGGER trg_audit_logs_milestone_project\s*\n\s*BEFORE INSERT ON audit_logs\s*\n\s*FOR EACH ROW\s*\n\s*WHEN \(left\(NEW\.action, 10\) = 'MILESTONE_'\)\s*\n\s*EXECUTE FUNCTION public\.stamp_milestone_audit_project\(\);/);
    const idx = C.indexOf("CREATE TRIGGER trg_audit_logs_milestone_project");
    expect(idx).toBeGreaterThan(C.indexOf("\nBEGIN;"));
    expect(idx).toBeLessThan(C.indexOf("\nCOMMIT;"));
    // the service pass first (a restore keeps its rows as written)
    expect(f.indexOf("IF auth.uid() IS NULL THEN RETURN NEW; END IF;")).toBeLessThan(f.indexOf("SELECT m.project_id INTO v_project"));
    // the writer's projectId never stands: the trigger decides it, and marks its own
    expect(f).not.toContain("IF NEW.details ? 'projectId' THEN RETURN NEW;");
    expect(f).toContain("NEW.details := NEW.details - 'projectId' - 'projectIdFrom' - 'orgLevel';");
    expect(f).toContain("NEW.details := NEW.details || jsonb_build_object('projectId', v_project::text, 'projectIdFrom', 'milestone');");
    // the milestone's own project, in the row's org; once it is gone, the
    // project its earlier rows in the same org and resource recorded
    expect(f).toContain("WHERE m.id = (NEW.details ->> 'milestoneId')::uuid AND m.org_id = NEW.org_id;");
    const gone = f.slice(f.indexOf("ELSIF COALESCE(NEW.resource_type, '') <> 'project' THEN"));
    expect(gone.length).toBeLessThan(f.length);
    expect(gone).toContain("WHERE a.resource_id = NEW.resource_id");
    expect(gone).toContain("AND a.org_id = NEW.org_id");
    expect(gone).toContain("AND a.details ->> 'milestoneId' = NEW.details ->> 'milestoneId'");
    // only the trigger's own stamps are trusted for a gone milestone
    expect(gone).toContain("AND a.details ->> 'projectIdFrom' = 'milestone'");
    // a milestone on no project carries the org-level marker, never a project (review major)
    expect(f).toContain("v_org_level := v_project IS NULL;");
    expect(f).toContain("NEW.details := NEW.details || jsonb_build_object('projectIdFrom', 'milestone', 'orgLevel', true);");
    // why the stamp is needed: the lib names the milestone, not the project,
    // and writes MILESTONE_DELETED once the row is gone
    const audit = readFileSync(join(root, "lib/audit.ts"), "utf8");
    expect(between(audit, "export async function logMilestoneEvent(", "\n}\n")).not.toMatch(/projectId/);
    const ms = readFileSync(join(root, "lib/milestones.ts"), "utf8");
    expect(ms).toContain("The MILESTONE_DELETED audit row is written only once the row is gone");
    // section 6's first branch is the projectId one
    const ref = fn("audit_row_project_ref_visible");
    expect(ref.indexOf("COALESCE(p_details ->> 'projectId', '')")).toBeLessThan(ref.indexOf("WHEN left(COALESCE(p_action, ''), 10) = 'MILESTONE_' THEN"));
  });
  it("an org-level (document-scoped, project-less) milestone's rows stay every member's after it is deleted: the trigger marks them, the DELETED row carries the newest mark, section 6 reads it (review major)", () => {
    const f = fn("stamp_milestone_audit_project");
    // the marker is decided before any write, from the milestone itself
    const found = f.indexOf("IF FOUND THEN\n    v_org_level := v_project IS NULL;");
    expect(found).toBeGreaterThan(f.indexOf("SELECT m.project_id INTO v_project"));
    // a gone milestone takes what the newest own stamp held — a project OR the org-level marker
    const gone = f.slice(f.indexOf("ELSIF COALESCE(NEW.resource_type, '') <> 'project' THEN"));
    expect(gone).toContain("COALESCE(a.details @> '{\"orgLevel\": true}'::jsonb, false)\n      INTO v_project, v_org_level");
    expect(gone).toContain("OR a.details @> '{\"orgLevel\": true}'::jsonb)");
    // a writer's orgLevel is stripped with its projectId, before anything is decided
    expect(f.indexOf("NEW.details := NEW.details - 'projectId' - 'projectIdFrom' - 'orgLevel';")).toBeLessThan(f.indexOf("SELECT m.project_id INTO v_project"));
    // section 6 trusts the marker only with the trigger's projectIdFrom, and only once the milestone is gone
    const ref = fn("audit_row_project_ref_visible");
    const exists = ref.indexOf("AND EXISTS (SELECT 1 FROM public.milestones m WHERE m.id = (p_details ->> 'milestoneId')::uuid)");
    const marker = ref.indexOf(`WHEN p_details @> '{"projectIdFrom": "milestone", "orgLevel": true}'::jsonb THEN true`);
    expect(exists).toBeGreaterThan(0);
    expect(marker).toBeGreaterThan(exists);
    expect(C).toContain(`audit_row_project_ref_visible('MILESTONE_COMPLETED', 'document', 'x', '{"milestoneId":"00000000-0000-0000-0000-000000000000","projectIdFrom":"milestone","orgLevel":true}'::jsonb)`);
    expect(C).toContain(`AND NOT audit_row_project_ref_visible('MILESTONE_COMPLETED', 'document', 'x', '{"milestoneId":"00000000-0000-0000-0000-000000000000","orgLevel":true}'::jsonb)`);
    // the header no longer says rows written after the paste can be lost
    const what = between(M, "-- WHAT:", "-- NOT a widening:");
    expect(what).toContain("§9 stamps every milestone row written from now on with\n--      its project or the org-level marker, and records that stamp as a\n--      signed-in caller deletes a document-scoped milestone, so the\n--      MILESTONE_DELETED row written after the delete keeps its reach even\n--      when every earlier row predates the paste — that is pre-migration\n--      history only.");
    expect(what).not.toContain("§9 stamps the project on every\n--      milestone row written from now on, so that is pre-migration history\n--      only.");
  });
  it("the newest own stamp is chosen by the server's clock, never the writer's; a project-typed delete is not traced (review minors)", () => {
    const f = fn("stamp_milestone_audit_project");
    const clock = f.indexOf('NEW."timestamp" := now();');
    expect(clock).toBeGreaterThan(f.indexOf("IF auth.uid() IS NULL THEN RETURN NEW; END IF;"));
    expect(clock).toBeLessThan(f.indexOf("IF NEW.details IS NULL OR jsonb_typeof(NEW.details) <> 'object' THEN RETURN NEW; END IF;"));
    expect(f).toContain('ORDER BY a."timestamp" DESC NULLS LAST');
    // the app's audit writer never sets the column, so the server's clock is what it already gets (DEFAULT now())
    const audit = readFileSync(join(root, "lib/audit.ts"), "utf8");
    expect(between(audit, "export async function logAuditAction(", "\n}\n")).not.toMatch(/timestamp:/);
    // a project-typed row's resource_id is the project — every row of the project shares it; SEC-20 decides it
    expect(f).toContain("ELSIF COALESCE(NEW.resource_type, '') <> 'project' THEN");
    const ref = fn("audit_row_project_ref_visible");
    expect(ref).toContain("CASE WHEN p_type = 'project' THEN true");
  });
  it("a signed-in delete of a document-scoped milestone records its scope first, so its MILESTONE_DELETED row keeps its reach when every earlier row predates the paste or none exists (review fix 5)", () => {
    const f = fn("record_milestone_scope_on_delete");
    expect(f).toMatch(/RETURNS trigger\s*\n\s*LANGUAGE plpgsql\s*\n\s*SECURITY DEFINER\s*\n\s*SET search_path = public/);
    // fires BEFORE the row goes, for a document-scoped milestone only, inside the one transaction
    expect(C).toMatch(/DROP TRIGGER IF EXISTS trg_milestones_record_scope_on_delete ON milestones;\s*\nCREATE TRIGGER trg_milestones_record_scope_on_delete\s*\n\s*BEFORE DELETE ON milestones\s*\n\s*FOR EACH ROW\s*\n\s*WHEN \(OLD\.document_id IS NOT NULL\)\s*\n\s*EXECUTE FUNCTION public\.record_milestone_scope_on_delete\(\);/);
    const idx = C.indexOf("CREATE TRIGGER trg_milestones_record_scope_on_delete");
    expect(idx).toBeGreaterThan(C.indexOf("CREATE TRIGGER trg_audit_logs_milestone_project"));
    expect(idx).toBeLessThan(C.indexOf("\nCOMMIT;"));
    // the service pass first, then the org's own delete (its FK cascade) writes nothing
    const svc = f.indexOf("IF auth.uid() IS NULL THEN RETURN OLD; END IF;");
    const org = f.indexOf("IF NOT EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id) THEN RETURN OLD; END IF;");
    const ins = f.indexOf("INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, details)");
    expect(svc).toBeGreaterThan(0);
    expect(svc).toBeLessThan(org);
    expect(org).toBeLessThan(ins);
    expect(f).toContain("IF OLD.document_id IS NULL THEN RETURN OLD; END IF;");
    // the row it writes: on the milestone's document — the resource lib/milestones.ts pickResource
    // chooses for a document-scoped milestone, so the DELETED row's fallback (same resource_id) finds it —
    // carrying the milestone's id and name, attributed to the deleter
    expect(f).toContain("VALUES ('MILESTONE_SCOPE_RECORDED', 'document', OLD.document_id::text, OLD.org_id, auth.uid(),\n          jsonb_build_object('milestoneId', OLD.id::text, 'name', OLD.name));");
    expect(f).not.toMatch(/projectId|orgLevel|projectIdFrom/); // section 9 stamps it — the milestone still exists
    const ms = readFileSync(join(root, "lib/milestones.ts"), "utf8");
    expect(between(ms, "function pickResource(", "\n}\n")).toMatch(/^function pickResource\([^)]*\) \{\n  if \(m\.documentId\) return \{ resourceType: "document" as const, resourceId: m\.documentId \};/);
    // its action is a MILESTONE_ row: section 9's trigger stamps it, and section 9's fallback reads it
    expect("MILESTONE_SCOPE_RECORDED".slice(0, 10)).toBe("MILESTONE_");
    const stamp = fn("stamp_milestone_audit_project");
    const gone = stamp.slice(stamp.indexOf("ELSIF COALESCE(NEW.resource_type, '') <> 'project' THEN"));
    expect(gone).toContain("AND left(a.action, 10) = 'MILESTONE_'");
    expect(gone).toContain("WHERE a.resource_id = NEW.resource_id");
    // why: the imports write no milestone audit row at all, and the delete writes its row once the milestone is gone
    for (const name of ["importGhostMilestones", "importMilestonesFromParsed"]) {
      const body = between(ms, `export async function ${name}(`, "\n}\n");
      expect(body, name).not.toMatch(/logMilestoneEvent|logAuditAction/);
    }
    expect(ms).toContain("The MILESTONE_DELETED audit row is written only once the row is gone");
    // probed after the transaction, and nobody may call it
    const probe = C.slice(C.indexOf("\nCOMMIT;"));
    expect(probe).toContain("t.tgname = 'trg_milestones_record_scope_on_delete'");
    expect(probe).toContain("pg_get_triggerdef(t.oid) LIKE '%BEFORE DELETE ON public.milestones%'");
    expect(probe).toContain("NOT has_function_privilege('authenticated', 'public.record_milestone_scope_on_delete()', 'EXECUTE')");
    // the document timeline names the row (lib/timeline.ts summarizeAudit)
    expect(summarizeAudit({ action: "MILESTONE_SCOPE_RECORDED", details: { name: "Hydrotest" } })).toBe("Milestone deletion recorded by the database: Hydrotest");
    expect(summarizeAudit({ action: "MILESTONE_SCOPE_RECORDED", details: {} })).toBe("Milestone deletion recorded by the database");
  });
  it("delete_project_record's purge writes no scope row, an ordinary signed-in delete still writes one — the trigger function transcribed statement by statement (review fix 6)", () => {
    // The purge: 20261103's delete_project_record is SECURITY DEFINER with auth.uid() still the caller,
    // and deletes the project's milestones between setting app.record_purge = 'project:<id>' and clearing it.
    // No later migration re-defines it (the newest definer found by scanning the sequence is 20261103's).
    const definers = numbered().filter((f) => /CREATE OR REPLACE FUNCTION\s+(public\.)?delete_project_record\s*\(/.test(code(mig(f))));
    expect(definers[definers.length - 1]).toBe("20261103_prj_roundG_project_closeout_rails.sql");
    const purge = between(code(mig("20261103_prj_roundG_project_closeout_rails.sql")), "CREATE OR REPLACE FUNCTION delete_project_record(", "\n$$;");
    expect(purge).toMatch(/LANGUAGE plpgsql SECURITY DEFINER/);
    expect(purge).toMatch(/v_actor\s+uuid := auth\.uid\(\);/);
    const set = purge.indexOf("PERFORM set_config('app.record_purge', 'project:' || p_project::text, true);");
    const del = purge.indexOf("DELETE FROM milestones WHERE project_id = p_project;");
    const clear = purge.indexOf("PERFORM set_config('app.record_purge', '', true);");
    expect(set).toBeGreaterThan(0);
    expect(set).toBeLessThan(del);
    expect(del).toBeLessThan(clear);

    // The trigger function, read as a list of guards and then the one INSERT; every guard must be one this
    // table knows (a new guard fails the test until it is transcribed here too).
    type Old = { id: string; project_id: string | null; document_id: string | null; org_id: string; name: string };
    type Ctx = { uid: string | null; purge: string | null; orgs: Set<string>; old: Old };
    const COND: Record<string, (x: Ctx) => boolean> = {
      "auth.uid() IS NULL": (x) => x.uid === null,
      // 'project:' || NULL is NULL, and NULL = '…' is not true
      "COALESCE(current_setting('app.record_purge', true), '') = 'project:' || OLD.project_id::text": (x) =>
        x.old.project_id !== null && (x.purge ?? "") === `project:${x.old.project_id}`,
      "OLD.document_id IS NULL": (x) => x.old.document_id === null,
      "NOT EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id)": (x) => !x.orgs.has(x.old.org_id),
    };
    const f = fn("record_milestone_scope_on_delete");
    let body = f.slice(f.indexOf("AS $$\nBEGIN\n") + "AS $$\nBEGIN\n".length, f.lastIndexOf("\n  RETURN OLD;\nEND;"))
      .split("\n").map((l) => l.replace(/\s+--\s.*$/, "")).join("\n").trim();
    const guards: Array<(x: Ctx) => boolean> = [];
    while (body.startsWith("IF ")) {
      const then = body.indexOf(" THEN");
      const end = body.indexOf("END IF;");
      const cond = body.slice(3, then);
      expect(body.slice(then + " THEN".length, end).trim(), cond).toBe("RETURN OLD;");
      expect(COND[cond], `untranscribed guard: ${cond}`).toBeTypeOf("function");
      guards.push(COND[cond]);
      body = body.slice(end + "END IF;".length).trim();
    }
    expect(body).toBe("INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, details)\n  VALUES ('MILESTONE_SCOPE_RECORDED', 'document', OLD.document_id::text, OLD.org_id, auth.uid(),\n          jsonb_build_object('milestoneId', OLD.id::text, 'name', OLD.name));");
    const fire = (x: Ctx): Array<{ action: string; resource_id: string; milestoneId: string }> =>
      guards.some((g) => g(x)) ? [] : [{ action: "MILESTONE_SCOPE_RECORDED", resource_id: x.old.document_id!, milestoneId: x.old.id }];

    const orgs = new Set(["o1"]);
    const ms = (i: number, project: string | null): Old => ({ id: `m${i}`, project_id: project, document_id: `d${i}`, org_id: "o1", name: `Task ${i}` });
    // delete_project_record over a 300-task schedule: the owner signed in, the purge GUC naming the project
    const schedule = Array.from({ length: 300 }, (_, i) => ms(i, "p1"));
    expect(schedule.flatMap((old) => fire({ uid: "u-owner", purge: "project:p1", orgs, old }))).toEqual([]);
    // an ordinary signed-in delete (lib/milestones.ts deleteMilestone — no GUC, or the purge's cleared '') still writes one
    expect(fire({ uid: "u-owner", purge: null, orgs, old: ms(1, "p1") })).toEqual([{ action: "MILESTONE_SCOPE_RECORDED", resource_id: "d1", milestoneId: "m1" }]);
    expect(fire({ uid: "u-owner", purge: "", orgs, old: ms(2, "p1") })).toHaveLength(1);
    // the GUC skips only the purged project's milestones: another project's, or one on no project, still writes
    expect(fire({ uid: "u-owner", purge: "project:p2", orgs, old: ms(3, "p1") })).toHaveLength(1);
    expect(fire({ uid: "u-owner", purge: "project:p1", orgs, old: ms(4, null) })).toHaveLength(1);
    // unchanged: the service pass, a milestone on no document, the org's own delete
    expect(fire({ uid: null, purge: null, orgs, old: ms(5, "p1") })).toEqual([]);
    expect(fire({ uid: "u-owner", purge: null, orgs, old: { ...ms(6, "p1"), document_id: null } })).toEqual([]);
    expect(fire({ uid: "u-owner", purge: null, orgs: new Set(), old: ms(7, "p1") })).toEqual([]);
    expect(guards).toHaveLength(4);
    // the final SELECT checks the purge guard on paste
    const probe = C.slice(C.indexOf("\nCOMMIT;"));
    expect(probe).toContain("AND prosrc LIKE '%IF COALESCE(current_setting(''app.record_purge'', true), '''') = ''project:'' || OLD.project_id::text THEN%'");
  });
  it("leaves the other audit_logs policies alone", () => {
    expect(C).not.toMatch(/audit_logs_insert|audit_logs_org_access/);
  });
});

describe("the DEC-30 inventory counts everything the migration narrows (review minor)", () => {
  const inv = between(C, "CREATE TEMP TABLE prj_g_j12_inventory AS", "\nBEGIN;");
  it("MON-12: quotes are judged as the rail judges them — the document's own link (through to_jsonb), then the contractor's company when flagged, then ANY do-not-use row the vendor name normalises to, then the company it binds to (the contractor's link, else one exact name) (review major; review fixes 4 and 5)", () => {
    const rows = inv.split(/UNION ALL/).filter((r) => /inventory \(MON-12\)/.test(r));
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toContain("FROM prj_g_j12_quotes\n");
    const quotes = between(inv, "prj_g_j12_quotes AS MATERIALIZED (", "\n)\nSELECT 'inventory (MON-12)");
    const own = quotes.indexOf("WHERE c.id = NULLIF(to_jsonb(d) ->> 'company_id', '')::uuid AND c.org_id = d.org_id");
    const party = quotes.indexOf("CASE WHEN pc.status IN ('do_not_use', 'inactive') THEN pc.status END,");
    const dnu = quotes.indexOf("CASE WHEN (d.org_id, pg_temp.prj_g_j12_name_key(d.vendor_name)) IN (SELECT f.org_id, f.k FROM prj_g_j12_dnu_keys f)\n                THEN 'do_not_use' END,");
    // review fix 5: the contractor's company is the binding when its link stands (it answers null when
    // active, as cost_doc_company_barred's last step does), else the one exact name
    const exact = quotes.indexOf("CASE WHEN pc.id IS NOT NULL THEN pc.status WHEN x.hits = 1 THEN x.status END) AS status");
    expect(quotes).toContain("LEFT JOIN project_parties pp ON pp.id = d.party_id\n    LEFT JOIN companies pc ON pc.id = pp.company_id AND pc.org_id = d.org_id\n");
    expect(quotes).not.toContain("FROM project_parties pp JOIN companies c");
    expect(own).toBeGreaterThan(0);
    expect(own).toBeLessThan(party);
    expect(party).toBeLessThan(dnu);
    expect(dnu).toBeLessThan(exact);
    expect(quotes).not.toMatch(/\bd\.company_id\b/); // a database without 20261096 still runs
    // the look-alike keys are do-not-use rows only (DEC-48's gate — review fix 4), one key per org and name
    expect(inv).toContain("prj_g_j12_dnu_keys AS MATERIALIZED (\n  SELECT DISTINCT c.org_id, pg_temp.prj_g_j12_name_key(c.name) AS k\n    FROM companies c\n   WHERE c.status = 'do_not_use' AND pg_temp.prj_g_j12_name_key(c.name) <> ''\n)");
    expect(inv).toContain("prj_g_j12_exact_names AS MATERIALIZED (\n  SELECT c.org_id, lower(c.name) AS n, COUNT(*) AS hits, min(c.status) AS status\n    FROM companies c\n   GROUP BY c.org_id, lower(c.name)\n)");
    expect(inv).not.toContain("'do_not_use', 'inactive')\n          AND pg_temp");
    // review minor: the registry's names are normalised ONCE, in the keys (no empty key), and each quote's name once,
    // looked up in an uncorrelated IN list (hashed once by the server; scratch PG16: 5,000 quotes beside 400
    // flagged rows in 85 ms, against 39 s re-normalising the registry inside each quote's subquery) — never a
    // per-quote subquery over the registry
    expect(inv.split("pg_temp.prj_g_j12_name_key(").length - 1).toBe(3);
    expect(quotes.split("pg_temp.prj_g_j12_name_key(").length - 1).toBe(1);
    expect(quotes).not.toMatch(/FROM companies c\s+WHERE c\.org_id = d\.org_id/);
    expect(quotes).toContain("LEFT JOIN prj_g_j12_exact_names x ON x.org_id = d.org_id AND x.n = lower(btrim(d.vendor_name)) AND btrim(d.vendor_name) <> ''");
    expect(inv).not.toContain("pg_temp.prj_g_j12_name_key(c.name) = pg_temp.prj_g_j12_name_key(d.vendor_name)");
  });
  it("the inventory's session copy of the normaliser is section 1's company_name_key, byte for byte (it runs before the transaction creates it)", () => {
    const temp = between(M, "CREATE OR REPLACE FUNCTION pg_temp.prj_g_j12_name_key(p_name text)", "\n$$;");
    const real = between(M, "CREATE OR REPLACE FUNCTION public.company_name_key(p_name text)", "\n$$;");
    const body = (x: string) => x.slice(x.indexOf("AS $$"));
    expect(body(temp)).toBe(body(real));
    expect(body(temp).length).toBeGreaterThan(400);
    expect(M.indexOf("CREATE OR REPLACE FUNCTION pg_temp.prj_g_j12_name_key")).toBeLessThan(M.indexOf("CREATE TEMP TABLE prj_g_j12_inventory AS"));
    expect(M.indexOf("CREATE OR REPLACE FUNCTION pg_temp.prj_g_j12_name_key")).toBeGreaterThan(M.indexOf("Apply 20261142_prj_roundG_project_audit_rows.sql first"));
  });
  it("SEC-21: link rows with no project named, rows whose project or link is gone, the milestone rows a later delete would hide, and the milestones whose delete now writes a scope row", () => {
    expect(inv).toContain("inventory (SEC-21): document-scoped milestones (a signed-in delete of one now first writes one MILESTONE_SCOPE_RECORDED audit row on its document");
    expect(inv).toContain("FROM milestones WHERE document_id IS NOT NULL");
    expect(inv).toContain("inventory (SEC-21): other BEFORE DELETE row triggers on milestones");
    expect(inv).toContain("AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 8) = 8\n   AND t.tgname <> 'trg_milestones_record_scope_on_delete'");
    expect(inv).toContain("inventory (SEC-21): intake-link audit rows (project_intake_link) with no details.projectId");
    expect(inv).toContain("inventory (SEC-21): intake-link and INTAKE_* audit rows whose named project no longer exists, or link rows with no project named whose link no longer exists");
    expect(inv).toContain("NOT EXISTS (SELECT 1 FROM projects p WHERE p.id::text = lower(a.details ->> 'projectId'))");
    expect(inv).toContain("NOT EXISTS (SELECT 1 FROM project_intake_links l WHERE l.id::text = lower(a.resource_id))");
    expect(inv).toContain("inventory (SEC-21): MILESTONE_* audit rows typed document (or untyped) with no details.projectId whose milestone is on a NON-private project");
    expect(inv).toContain("inventory (SEC-21): MILESTONE_* audit rows typed document (or untyped) with no details.projectId and no org-level marker whose milestone is on NO project");
    expect(inv).toContain("AND NOT COALESCE(a.details @> '{\"projectIdFrom\": \"milestone\", \"orgLevel\": true}'::jsonb, false)\n   AND m.project_id IS NULL");
    expect(inv).toContain("inventory (SEC-21 / SAF-9): other BEFORE INSERT row triggers on audit_logs");
    expect(inv).toContain("AND t.tgname NOT IN ('trg_audit_logs_milestone_project', 'trg_audit_logs_intake_outcome_notice');");
    expect(inv).toContain("inventory (SAF-9): contractor outcome notice rows already on the trail");
  });
});

describe("SAF-9 — the contractor outcome notice is claimed once per attempt", () => {
  it("a UNIQUE partial index on the claim rows (org, version, attempt), inside the one transaction, probed after it", () => {
    const idx = C.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_intake_outcome_notice_claim_uniq");
    expect(idx).toBeGreaterThan(C.indexOf("\nBEGIN;"));
    expect(idx).toBeLessThan(C.indexOf("\nCOMMIT;"));
    expect(C).toMatch(/ON audit_logs \(org_id, \(details ->> 'versionId'\), \(details ->> 'attempt'\)\)\s*\n\s*WHERE action = 'INTAKE_OUTCOME_NOTICE_CLAIMED';/);
    expect(C.slice(C.indexOf("\nCOMMIT;"))).toContain("indexname = 'audit_logs_intake_outcome_notice_claim_uniq'");
    // the route claims with exactly these keys
    const route = readFileSync(join(root, "app/api/intake/outcome-notice/route.ts"), "utf8");
    expect(route).toContain('const CLAIMED = "INTAKE_OUTCOME_NOTICE_CLAIMED";');
    // (projects Round G J14, MON-10: the claim → send → record sequence is one
    // helper shared by a submission's notice and a quote's; the claim row's
    // keys are still versionId — the decided record's id — and attempt.)
    expect(route).toContain("details: { versionId: key, attempt, ...n.claimDetails },");
    expect(route).toContain("claimDetails: { projectId: l.project_id, linkId: l.id, outcome },");
    expect(route).toContain("key: versionId,");
    expect(route.indexOf("action: CLAIMED")).toBeLessThan(route.indexOf('await fetch("https://api.resend.com/emails"'));
  });
  it("the notice's three rows are the route's: a signed-in insert of one is refused; the route writes them as the service role (review minor)", () => {
    const f = fn("enforce_intake_outcome_notice_server_only");
    expect(f).toMatch(/RETURNS trigger\s*\n\s*LANGUAGE plpgsql\s*\n\s*SECURITY INVOKER\s*\n\s*SET search_path = public/);
    expect(f.indexOf("IF auth.uid() IS NULL THEN RETURN NEW; END IF;")).toBeLessThan(f.indexOf("RAISE EXCEPTION"));
    expect(f).toContain("USING ERRCODE = 'insufficient_privilege';");
    for (const role of ["PUBLIC", "anon", "authenticated"]) {
      expect(C).toContain(`REVOKE ALL ON FUNCTION public.enforce_intake_outcome_notice_server_only() FROM ${role};`);
    }
    expect(C).toMatch(/CREATE TRIGGER trg_audit_logs_intake_outcome_notice\s*\n\s*BEFORE INSERT ON audit_logs\s*\n\s*FOR EACH ROW\s*\n\s*WHEN \(NEW\.action IN \('INTAKE_OUTCOME_NOTICE_CLAIMED', 'INTAKE_OUTCOME_NOTICE_FAILED', 'INTAKE_OUTCOME_NOTIFIED'\)\)\s*\n\s*EXECUTE FUNCTION public\.enforce_intake_outcome_notice_server_only\(\);/);
    const idx = C.indexOf("CREATE TRIGGER trg_audit_logs_intake_outcome_notice");
    expect(idx).toBeGreaterThan(C.indexOf("\nBEGIN;"));
    expect(idx).toBeLessThan(C.indexOf("\nCOMMIT;"));
    expect(C.slice(C.indexOf("\nCOMMIT;"))).toContain("t.tgname = 'trg_audit_logs_intake_outcome_notice'");
    // the route's three actions are exactly these, and every write of them goes through the service-role client
    const route = readFileSync(join(root, "app/api/intake/outcome-notice/route.ts"), "utf8");
    expect(route).toContain('const NOTIFIED = "INTAKE_OUTCOME_NOTIFIED";');
    expect(route).toContain('const FAILED = "INTAKE_OUTCOME_NOTICE_FAILED";');
    const inserts = route.match(/\.from\("audit_logs"\)\.insert\(/g) ?? [];
    expect(inserts.length).toBe(3);
    expect(route.match(/supabaseAdmin\.from\("audit_logs"\)\.insert\(/g)).toHaveLength(3);
    // no other file writes them
    const libNotice = readFileSync(join(root, "lib/intakeOutcomeNotice.ts"), "utf8");
    expect(libNotice).not.toMatch(/INTAKE_OUTCOME_NOTI(FIED|CE_)/);
  });
});
