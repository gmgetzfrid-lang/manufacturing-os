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
  it("is named in the package's reserved number and the sequence holds no other 20261157", () => {
    expect(numbered().filter((f) => f.startsWith("20261157"))).toEqual([FILE]);
  });
});

describe("DRLS-16 — every function this migration adds", () => {
  const added = [
    "cost_doc_company_behind", "enforce_cost_document_award_registry", "award_quote",
    "apply_checklist_item_writes", "enforce_project_party_company_link", "enforce_quality_item_contractor",
    "audit_row_project_ref_visible",
  ];
  it("each is NEW — no earlier migration defines it (so there is no older body to start from)", () => {
    for (const f of numbered().filter((x) => x < FILE)) {
      const sql = code(mig(f));
      for (const name of added) expect(sql, `${f} defines ${name}`).not.toMatch(new RegExp(`FUNCTION\\s+(public\\.)?${name}\\s*\\(`));
    }
  });
  it("the one SECURITY DEFINER (the registry rail) pins search_path and is revoked from PUBLIC, anon and authenticated", () => {
    const definers = [...C.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\([^)]*\)[\s\S]*?AS \$\$/g)].filter((m) => /SECURITY DEFINER/.test(m[0]));
    expect(definers.map((m) => m[1])).toEqual(["enforce_cost_document_award_registry"]);
    expect(definers[0][0]).toMatch(/SECURITY DEFINER\s*\n\s*SET search_path = public/);
    for (const role of ["PUBLIC", "anon", "authenticated"]) {
      expect(C).toContain(`REVOKE ALL ON FUNCTION public.enforce_cost_document_award_registry() FROM ${role};`);
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
    for (const name of ["enforce_cost_document_award_registry", "enforce_project_party_company_link", "enforce_quality_item_contractor"]) {
      expect(fn(name)).toMatch(/RETURNS trigger/);
      expect(fn(name)).toContain("IF auth.uid() IS NULL THEN RETURN NEW; END IF;");
      expect(C).toContain(`REVOKE ALL ON FUNCTION public.${name}() FROM anon;`);
    }
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
    expect(guard).toBeLessThan(rail.indexOf("v_company := cost_doc_company_behind("));
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
    expect(rpc).toContain("RETURN jsonb_build_object('ok', false, 'code', 'company_flagged', 'company', v_company);");
    expect(rpc).toContain("IF v_flagged THEN PERFORM set_config('app.cost_doc_award_override', p_doc::text, true); END IF;");
    expect(rpc).toContain("PERFORM set_config('app.cost_doc_award_override', '', true);");
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
  it("guards each row on updated_at AS READ and the checklist, one sub-transaction per row", () => {
    expect(rpc).toContain("AND ci.checklist_id = p_checklist");
    expect(rpc).toContain("AND ci.updated_at IS NOT DISTINCT FROM NULLIF(v_write ->> 'expected_updated_at', '')::timestamptz");
    expect(rpc).toMatch(/BEGIN\s*\n\s*v_id := \(v_write ->> 'id'\)::uuid;[\s\S]*EXCEPTION WHEN OTHERS THEN/);
    expect(rpc).toContain("RETURN jsonb_build_object('landed', v_landed, 'refused', v_refused, 'failed', v_failed);");
  });
  it("writes only the machine actor's columns, stamps updated_by NULL itself, and accepts only the two machine names lib/checklistEngine uses", () => {
    expect(rpc).toContain(`NOT IN ('${MACHINE_ACTOR_SWEEP}', '${MACHINE_ACTOR_ASSESSMENT}')`);
    for (const col of ["status", "applicability", "ai_rationale", "evidence"]) expect(rpc).toContain(`${col} = CASE WHEN v_write ? '${col}'`);
    expect(rpc).toContain("updated_by = NULL,");
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
    expect(f.slice(orgLevel)).toMatch(/^WHEN p_type = 'milestone' THEN true\s*\n\s*ELSE false END/);
    // lib/milestones.ts writes 'milestone' only for a milestone on no project and no document
    const ms = readFileSync(join(root, "lib/milestones.ts"), "utf8");
    expect(ms).toMatch(/function pickResource\(/);
    expect(C).toContain("audit_row_project_ref_visible('MILESTONE_DELETED', 'milestone', '00000000-0000-0000-0000-000000000000', '{\"milestoneId\":\"00000000-0000-0000-0000-000000000000\"}'::jsonb)");
  });
  it("leaves the other audit_logs policies alone", () => {
    expect(C).not.toMatch(/audit_logs_insert|audit_logs_org_access/);
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
    expect(route).toContain("details: { versionId, attempt, projectId: l.project_id, linkId: l.id, outcome },");
    expect(route.indexOf("action: CLAIMED")).toBeLessThan(route.indexOf('await fetch("https://api.resend.com/emails"'));
  });
});
