// projects-joint J16 INTAKE DOOR IDENTITY — the shape of 20261184 (projects-tab
// GAP-401, owed item 1): the contractor door's content writes go through
// SECURITY DEFINER door functions that resolve the link from its token hash,
// refuse a write outside the link's scope, and bind a transaction-local
// identity (the link; for the promote, the link's creator) so every guard
// judges the door's write; INTK-16's authorship rail re-created from its
// NEWEST body with one block admitting that identity for its own link.
//
// No live database here: the migration is read as text — the one-paste
// protocol (DEC-30), DRLS-16 for every function it adds, the byte-fidelity of
// the one function it RE-creates against its newest definition found by
// scanning the sequence at test time, and the parity of the SQL with the route
// that calls it. The file also ran end to end on a scratch PostgreSQL 16
// cluster with a Supabase-shaped stub and the REAL guards (publish guard
// 20261174, publish_revision 20261151, register / hold-label / insert-pointer
// rails, unit-code guard, the project record rail, append_ticket_redline
// 20261166) — the scenarios and their answers are recorded on GAP-401.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CLOSED_PROJECT_STATUSES } from "@/lib/intakeLinks";
import { EXPECTED_FUNCTIONS } from "@/lib/schemaExpectations";

const root = process.cwd();
const migDir = join(root, "supabase", "migrations");
const FILE = "20261184_prj_roundG_intake_door_identity.sql";
const mig = (f: string) => readFileSync(join(migDir, f), "utf8");
const M = mig(FILE);
const code = (sql: string) => sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const C = code(M);
const numbered = () => readdirSync(migDir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const ROUTE = readFileSync(join(root, "app/api/intake/upload/route.ts"), "utf8");

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
const fn = (name: string) => between(M, `CREATE OR REPLACE FUNCTION public.${name}(`, "\n$$;");

const DOOR = ["intake_door_create_document", "intake_door_submit_version", "intake_door_point_pending",
  "intake_door_promote", "intake_door_file_quote", "intake_door_append_redline"] as const;
const HELPERS = ["intake_door_resolve", "intake_door_bind", "intake_door_unbind"] as const;
const SIG: Record<string, string> = {
  intake_door_resolve: "text",
  intake_door_bind: "uuid, uuid, uuid, uuid",
  intake_door_unbind: "jsonb",
  intake_door_create_document: "text, jsonb",
  intake_door_submit_version: "text, jsonb",
  intake_door_point_pending: "text, uuid, uuid, uuid, timestamptz",
  intake_door_promote: "text, uuid, uuid, jsonb, text",
  intake_door_file_quote: "text, jsonb",
  intake_door_append_redline: "text, uuid, jsonb, jsonb",
};

describe("the one-paste protocol (DEC-30)", () => {
  it("refuses to run without 20261141, then a TEMP inventory of COUNTs BEFORE the one transaction, and ONE final SELECT (check, ok, n)", () => {
    const guard = C.indexOf("Apply 20261141_prj_roundG_intake_token_hash_and_adoption.sql");
    const temp = C.indexOf("CREATE TEMP TABLE prj_g_j16_inventory AS");
    const begin = C.indexOf("\nBEGIN;");
    const commit = C.indexOf("\nCOMMIT;");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(temp);
    expect(temp).toBeLessThan(begin);
    expect(begin).toBeLessThan(commit);
    expect(C.match(/\nBEGIN;/g)).toHaveLength(1);
    expect(C.match(/\nCOMMIT;/g)).toHaveLength(1);
    const tail = C.slice(commit);
    expect(tail).toMatch(/SELECT '[^']+' AS check,\s*\n\s*\([\s\S]*?\) AS ok,\s*\n\s*NULL::text AS n/);
    expect(tail.match(/;\s*$/gm)).toHaveLength(2); // "COMMIT;" and the one SELECT's end
    expect(tail).toMatch(/SELECT inventory, NULL::boolean, n FROM prj_g_j16_inventory;\s*$/);
    const inv = between(C, "CREATE TEMP TABLE prj_g_j16_inventory AS", "\nBEGIN;");
    for (const sel of inv.split(/UNION ALL/)) expect(sel, sel).toMatch(/COUNT\(\*\)::text/);
    // the prerequisite reads the 20261141 body this file re-creates (prosrc is verbatim)
    expect(between(C, "DO $$", "END;\n$$;")).toContain("prosrc LIKE '%Only the contractor door records that a link authored a document%'");
  });
  it("is the package's reserved number, and the sequence holds no other 20261184", () => {
    expect(numbered().filter((f) => f.startsWith("20261184"))).toEqual([FILE]);
  });
  it("the header says why this is not RLS, the paste order, the re-paste warning and the deploy order", () => {
    const head = M.slice(0, M.indexOf("-- ── Prerequisite"));
    expect(head).toContain("WHY THIS SHAPE (and not RLS insert policies)");
    expect(head).toContain("minting one needs the project's JWT signing secret, which this\n-- app does not hold");
    expect(head).toContain("projects-tab SEC-22, opened by this package");
    expect(head).toContain("PASTE ORDER: after 20261141 (required");
    expect(head).toContain("⚠ Never re-paste 20261141 after this file");
    expect(head).toContain("DEPLOY ORDER: none required.");
    expect(head).toContain("PGRST202, or 42883 naming an\n-- intake_door_ function");
  });
});

describe("DRLS-16 — every function this migration adds", () => {
  it("each is NEW — no earlier migration defines any intake_door_ function", () => {
    for (const f of numbered().filter((x) => x < FILE)) {
      expect(code(mig(f)), f).not.toMatch(/FUNCTION\s+(public\.)?intake_door_\w+\s*\(/);
    }
  });
  it("the six door functions — and only they — are SECURITY DEFINER, pin search_path, are revoked from PUBLIC, anon and authenticated and granted to the service role alone", () => {
    const definers = [...C.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\([^)]*\)[\s\S]*?AS \$\$/g)].filter((m) => /SECURITY DEFINER/.test(m[0]));
    expect(definers.map((m) => m[1])).toEqual([...DOOR]);
    for (const d of definers) {
      expect(d[0]).toMatch(/SECURITY DEFINER\s*\n\s*SET search_path = public/);
      expect(C).toContain(`REVOKE ALL ON FUNCTION public.${d[1]}(${SIG[d[1]]}) FROM PUBLIC, anon, authenticated;`);
      expect(C).toContain(`GRANT EXECUTE ON FUNCTION public.${d[1]}(${SIG[d[1]]}) TO service_role;`);
    }
    // no client role but the service role is ever granted one
    expect(C).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.intake_door_\w+\([^)]*\) TO [^;]*(anon|authenticated|PUBLIC)/);
  });
  it("each door function resolves the link from its token hash first — and the resolver refuses a signed-in caller (a NULL auth.uid() is trusted only because anon and authenticated cannot EXECUTE)", () => {
    for (const name of DOOR) expect(fn(name)).toMatch(/DECLARE\s*\n\s*v_door\s+jsonb\s*:= intake_door_resolve\(p_token_hash\);/);
    const resolve = fn("intake_door_resolve");
    expect(resolve).toMatch(/BEGIN\s*\n\s*IF auth\.uid\(\) IS NOT NULL THEN\s*\n\s*RAISE EXCEPTION 'intake_door: only the intake route, under the service key, opens the contractor door\.'\s*\n\s*USING ERRCODE = '42501';/);
  });
  it("the three helpers are SECURITY INVOKER and no client role — not even the service role — may EXECUTE them (only the door functions, as their owner)", () => {
    for (const name of HELPERS) {
      const head = between(M, `CREATE OR REPLACE FUNCTION public.${name}(`, "AS $$");
      expect(head, name).not.toMatch(/SECURITY DEFINER/);
      expect(C).toContain(`REVOKE ALL ON FUNCTION public.${name}(${SIG[name]}) FROM PUBLIC, anon, authenticated, service_role;`);
      expect(C).not.toMatch(new RegExp(`GRANT [^;]*${name}`));
    }
  });
});

describe("the door's identity and scope", () => {
  it("the resolver: the link by its hash, refused (28000 + HINT) when revoked, expired, its project gone or closed — the route's CLOSED_PROJECT_STATUSES", () => {
    const r = fn("intake_door_resolve");
    expect(r).toContain("SELECT * INTO v_link FROM project_intake_links WHERE token_hash = p_token_hash;");
    for (const hint of ["notfound", "revoked", "expired", "link_gone", "project_closed"]) expect(r).toContain(`USING ERRCODE = '28000', HINT = '${hint}';`);
    const closed = r.match(/IF v_project\.status IN \(([^)]+)\) THEN/)![1].split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(closed.sort()).toEqual([...CLOSED_PROJECT_STATUSES].sort());
  });
  it("the bound identity: sub, role 'intake_door' and the link — in request.jwt.claims and the legacy claim GUCs — restored before each writer returns; the redline binds none", () => {
    const bind = fn("intake_door_bind");
    expect(bind).toContain("jsonb_build_object('sub', p_sub, 'role', 'intake_door', 'intake_link_id', p_link,");
    expect(bind).toContain("PERFORM set_config('request.jwt.claim.sub', p_sub::text, true);");
    expect(bind).toContain("PERFORM set_config('request.jwt.claim.role', 'intake_door', true);");
    for (const name of ["intake_door_create_document", "intake_door_submit_version", "intake_door_point_pending", "intake_door_file_quote"]) {
      const body = fn(name);
      expect(body, name).toContain("v_prev := intake_door_bind(v_link, v_link, v_org, v_proj);");
      expect(body.indexOf("intake_door_bind("), name).toBeLessThan(body.search(/\n\s*(INSERT INTO|UPDATE documents)/));
      expect(body.lastIndexOf("PERFORM intake_door_unbind(v_prev);"), name).toBeGreaterThan(body.search(/\n\s*(INSERT INTO|UPDATE documents)/));
    }
    const promote = fn("intake_door_promote");
    expect(promote).toContain("v_prev := intake_door_bind(v_creator::uuid, v_link, v_org, v_proj);");
    expect(promote.indexOf("intake_door_bind(")).toBeLessThan(promote.indexOf("v_res := publish_revision("));
    expect(promote.indexOf("PERFORM intake_door_unbind(v_prev);")).toBeGreaterThan(promote.indexOf("UPDATE document_versions SET intake_link_id = v_link"));
    expect(fn("intake_door_append_redline")).not.toContain("intake_door_bind(");
  });
  it("every write is pinned to the link: org, library, folder, link, provenance and review state from the database — never from the caller's row", () => {
    const create = fn("intake_door_create_document");
    expect(create).toContain("VALUES (v_org, v_lib, v_col, v_row.name, v_row.title, v_row.document_number, 'Draft',");
    expect(create).toContain("v_row.created_by_name, COALESCE(v_row.updated_at, NOW()), v_row.uniqueness_key, v_link)");
    expect(create).toContain("IF NULLIF(p_doc->>'collection_id', '')::uuid IS DISTINCT FROM v_col");
    const submit = fn("intake_door_submit_version");
    expect(submit).toContain("VALUES (v_org, v_v.record_id, v_v.revision_label, v_v.file_url, v_v.file_type, v_v.size, v_v.change_log,");
    expect(submit).toContain("v_v.created_by_name, COALESCE(v_v.created_at, NOW()), NULL, 'in_review', 'external',");
    expect(submit).toContain("AND (d.authored_by_link_id = v_link\n                         OR d.id::text IN (SELECT jsonb_array_elements_text(v_door->'assigned')))");
    const point = fn("intake_door_point_pending");
    expect(point).toContain("AND v.intake_link_id = v_link AND v.review_state = 'in_review' AND v.superseded_at IS NULL");
    expect(point).toContain("WHERE id = p_doc AND org_id = v_org AND pending_version_id IS NOT DISTINCT FROM p_from;");
    expect(point).toMatch(/IF p_from IS NOT NULL\s*\n\s*AND NOT \(COALESCE\(\(v_door->>'trusted'\)::boolean, false\)/);
    const promote = fn("intake_door_promote");
    expect(promote).toContain("IF NOT COALESCE((v_door->>'trusted')::boolean, false) THEN");
    expect(promote).toContain("OR v_doc.authored_by_link_id IS DISTINCT FROM v_link");
    expect(promote).toContain("OR v_doc.current_version_id IS NULL THEN");
    expect(promote).toContain("p_actor => v_creator::uuid,");
    const quote = fn("intake_door_file_quote");
    expect(quote).toContain("IF v_door->>'purpose' IS DISTINCT FROM 'quote' THEN");
    expect(quote).toContain("VALUES (v_org, v_proj, 'quote', v_q.file_url, v_q.file_name, v_q.mime_type, v_door->>'company',");
    expect(quote).toContain("v_door->>'rfq_group', v_link, v_q.party_id, 'draft', NULL, v_q.file_hash)");
    const red = fn("intake_door_append_redline");
    expect(red).toContain("SELECT t.metadata->'intake_collision'->>'intakeLinkId' INTO v_named FROM tickets t WHERE t.id = p_ticket AND t.org_id = v_org;");
    expect(red).toContain("RETURN append_ticket_redline(p_ticket, v_org, p_attachment, p_history);");
    expect(red).toMatch(/to_regprocedure\('public\.append_ticket_redline\(uuid, uuid, jsonb, jsonb\)'\) IS NULL THEN[\s\S]*?USING ERRCODE = '42883';/);
  });
  it("the storage-key scope mirrors the keys the route builds — the link's project prefix, nothing above it", () => {
    expect(ROUTE).toContain("const key = `orgs/${orgId}/project-intake/${projectId}/${crypto.randomUUID()}-${safeName}`;");
    expect(ROUTE).toContain("const key = `orgs/${orgId}/project-intake/${projectId}/redlines/${crypto.randomUUID()}-${safeName}`;");
    expect(ROUTE).toContain("const key = `orgs/${orgId}/project-costs/${projectId}/quote-${crypto.randomUUID()}-${safeName}`;");
    expect(fn("intake_door_submit_version")).toContain("v_v.file_url !~ ('^orgs/' || v_org::text || '/project-intake/' || v_proj::text || '/[^/]+$')");
    expect(fn("intake_door_promote")).toContain("COALESCE(p_version->>'file_url', '') !~ ('^orgs/' || v_org::text || '/project-intake/' || v_proj::text || '/[^/]+$')");
    expect(fn("intake_door_append_redline")).toContain("COALESCE(p_attachment->>'url', '') !~ ('^orgs/' || v_org::text || '/project-intake/' || v_proj::text || '/redlines/[^/]+$')");
    expect(fn("intake_door_file_quote")).toContain("v_q.file_url !~ ('^orgs/' || v_org::text || '/project-costs/' || v_proj::text || '/quote-[^/]+$')");
    // the route's safe name holds no '/', so a key built that way always matches its pattern
    expect(ROUTE).toContain('file.name.replace(/[^\\w.\\-]+/g, "_")');
  });
});

describe("the route calls each door function with the parameters the SQL declares", () => {
  const params = (name: string) => [...between(M, `CREATE OR REPLACE FUNCTION public.${name}(`, ")\nRETURNS").matchAll(/(p_\w+)\s+(\w+)(\s+DEFAULT [^,)]+)?/g)]
    .map((m) => ({ name: m[1], required: !m[3] }));
  it.each([...DOOR])("%s", (name) => {
    const call = ROUTE.match(new RegExp(`supabaseAdmin\\.rpc\\("${name}", \\{([\\s\\S]*?)\\n?\\s*\\}\\)\\)`));
    expect(call, `${name} is called by the route`).not.toBeNull();
    // the top-level keys of the argument object (nested objects' keys are not p_)
    const sent = [...new Set([...call![1].matchAll(/\b(p_\w+)\s*:/g)].map((m) => m[1]))];
    const declared = params(name);
    expect(sent.every((k) => declared.some((d) => d.name === k)), `${name}: ${sent.join(", ")}`).toBe(true);
    for (const d of declared.filter((x) => x.required)) expect(sent, `${name} requires ${d.name}`).toContain(d.name);
    // and it is the token's SHA-256 the door resolves by — never an id the route chose
    expect(call![1]).toMatch(/p_token_hash: (input\.door\.)?tokenHash/);
  });
  it("the promote names no actor: the creator comes from the link row in the database", () => {
    const call = ROUTE.match(/supabaseAdmin\.rpc\("intake_door_promote", \{([\s\S]*?)\}\)\)/)![1];
    expect(call).not.toMatch(/p_actor\s*:/);
  });
  it("the route treats only 'the function is not there' as today's path — decided by the CODE (PGRST202, or 42883 naming an intake_door_ function at its start), never by a message alone", () => {
    const absent = between(ROUTE, "function doorFunctionAbsent(e: DoorError): boolean {", "\n}");
    expect(absent).toContain('if (code === "PGRST202") return true;');
    expect(absent).toContain('if (code !== "42883") return false;');
    expect(absent).toContain('return /^function (public\\.)?intake_door_[a-z_]+\\(/.test(msg) || msg.startsWith("intake_door_append_redline:");');
    // no code-agnostic message match: a guard's message can carry contractor text
    expect(absent).not.toMatch(/could not find the function/i);
    expect(absent).not.toMatch(/msg\.includes\(/);
    // the redline door's own 42883 names itself FIRST, so it is one of those answers
    expect(fn("intake_door_append_redline")).toContain("RAISE EXCEPTION 'intake_door_append_redline: append_ticket_redline (20261166) is not installed yet");
    // and no other migration raises 42883 itself (a guard's 42883 could otherwise be read as "absent")
    const raisers = readdirSync(join(process.cwd(), "supabase/migrations"))
      .filter((f) => /^\d+_.*\.sql$/.test(f) && readFileSync(join(process.cwd(), "supabase/migrations", f), "utf8").match(/ERRCODE\s*=\s*'42883'|undefined_function/));
    expect(raisers).toEqual([FILE]);
  });
  it("schema health probes two door functions, every required parameter named, the uuid argument one its type refuses (the body never runs)", () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const name of ["intake_door_promote", "intake_door_point_pending"]) {
      const row = EXPECTED_FUNCTIONS.find((f) => f.fn === name)!;
      expect(row.migration).toBe(FILE);
      expect(row.signature).toBe(`${name}(${SIG[name]})`);
      const required = params(name).filter((p) => p.required).map((p) => p.name).sort();
      expect(Object.keys(row.probeArgs).sort()).toEqual(required);
      expect(String(row.probeArgs.p_doc)).not.toMatch(uuid);
    }
  });
});

describe("INTK-16's authorship rail — re-created from its NEWEST body + one block", () => {
  const body = (sql: string) => between(sql, "CREATE OR REPLACE FUNCTION documents_authorship_fixed()", "\n$$;");
  const newestEarlier = () => {
    const files = numbered().filter((f) => f < FILE && /CREATE OR REPLACE FUNCTION documents_authorship_fixed\(\)/.test(code(mig(f))));
    return files[files.length - 1];
  };
  it("the newest earlier definition is found by scanning the sequence (today 20261141)", () => {
    expect(newestEarlier()).toBe("20261141_prj_roundG_intake_token_hash_and_adoption.sql");
  });
  it("every line of that body is kept; the lines added are exactly the J16 block", () => {
    const { onlyInA, onlyInB } = lineDiff(body(mig(newestEarlier())), body(M));
    const block = [
      "  -- J16 (GAP-401, 20261184): the contractor door's own identity — bound only",
      "  -- by the intake_door_* functions (service key only), for ONE link — records",
      "  -- that link, and no other, as the author of the document it creates. Every",
      "  -- rule below binds the door like any signed-in writer.",
      "  IF TG_OP = 'INSERT'",
      "     AND NEW.authored_by_link_id IS NOT NULL",
      "     AND COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'intake_door'",
      "     AND NEW.authored_by_link_id::text = auth.uid()::text",
      "     AND NEW.authored_by_link_id::text = (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'intake_link_id') THEN",
      "    RETURN NEW;",
      "  END IF;",
    ];
    expect(onlyInA).toEqual([]);
    // ("  END IF;" also occurs in the base, so a set difference does not list it)
    expect(onlyInB).toEqual(block.filter((l) => l !== "  END IF;"));
    // the block is contiguous, right after the service pass, and removing it gives the base back byte for byte
    expect(body(M)).toContain(`IF auth.uid() IS NULL THEN RETURN NEW; END IF;   -- the door and the org restore (service role), the SQL editor\n${block.join("\n")}\n  IF TG_OP = 'INSERT' THEN`);
    expect(body(M).replace(`${block.join("\n")}\n`, "")).toBe(body(mig(newestEarlier())));
  });
  it("the block sits after the service pass and before both refusals, and the function stays SECURITY INVOKER with its search_path pinned", () => {
    const b = body(M);
    expect(b).toMatch(/^CREATE OR REPLACE FUNCTION documents_authorship_fixed\(\)\nRETURNS trigger LANGUAGE plpgsql SET search_path = public AS \$\$/);
    const pass = b.indexOf("IF auth.uid() IS NULL THEN RETURN NEW; END IF;");
    const block = b.indexOf("= 'intake_door'");
    const refuse = b.indexOf("Only the contractor door records that a link authored a document");
    expect(pass).toBeGreaterThan(0);
    expect(pass).toBeLessThan(block);
    expect(block).toBeLessThan(refuse);
    // the role the rail admits is the role the door binds
    expect(fn("intake_door_bind")).toContain("'role', 'intake_door'");
    // the trigger is not re-created: CREATE OR REPLACE keeps it and its grants
    expect(C).not.toMatch(/CREATE TRIGGER|DROP TRIGGER/);
  });
});
