// projects-joint J16 INTAKE DOOR IDENTITY — the shape of 20261184 (projects-tab
// GAP-401, owed item 1): the contractor door's content writes go through door
// functions that resolve the link from its token hash, refuse a write outside
// the link's scope, and bind a transaction-local identity (the link; for the
// promote, the link's creator) so every guard judges the door's write. The new
// document and the quote are also written UNDER ROW-LEVEL SECURITY: the door
// function (SECURITY INVOKER, under the service key) switches to the dedicated
// NOLOGIN role intake_door — granted to authenticator, no BYPASSRLS — for the
// one INSERT, and policies TO intake_door keyed on the bound link judge it (no
// JWT and no signing secret: review fix pass 2). INTK-16's authorship rail is
// re-created from its NEWEST body with one block admitting that identity for
// its own link.
//
// No live database here: the migration is read as text — the one-paste
// protocol (DEC-30), DRLS-16 for every function it adds, the role's grants and
// policies, the byte-fidelity of the one function it RE-creates against its
// newest definition found by scanning the sequence at test time, and the
// parity of the SQL with the route that calls it. The file also ran end to end
// on a scratch PostgreSQL 16 cluster carrying the WHOLE sequence (schema.sql
// and every migration, applied as a non-superuser postgres with a
// Supabase-shaped auth schema and authenticator login) — the scenarios and
// their answers are recorded on GAP-401.

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
/** A comment block as one line of prose (the "-- " prefixes and line breaks gone). */
const prose = (text: string) => text.split("\n").map((l) => l.replace(/^--\s?/, "")).join(" ").replace(/\s+/g, " ");
/** The two door functions that INSERT under row-level security, as intake_door. */
const RLS_DOOR = ["intake_door_create_document", "intake_door_file_quote"] as const;
/** The policy predicates the intake_door policies call (intake_door's alone). */
const PREDICATES = ["intake_door_may_create", "intake_door_may_quote"] as const;

const DOOR = ["intake_door_create_document", "intake_door_submit_version", "intake_door_point_pending",
  "intake_door_promote", "intake_door_file_quote", "intake_door_append_redline"] as const;
const HELPERS = ["intake_door_resolve", "intake_door_bind", "intake_door_unbind", "intake_door_rls_gaps", "intake_door_rls_ready"] as const;
const SIG: Record<string, string> = {
  intake_door_resolve: "text",
  intake_door_bind: "uuid, uuid, uuid, uuid",
  intake_door_unbind: "jsonb",
  intake_door_rls_gaps: "name, boolean",
  intake_door_rls_ready: "boolean",
  intake_door_bound: "",
  intake_door_may_create: "uuid, uuid, uuid, uuid, text",
  intake_door_may_quote: "uuid, uuid, text, uuid, text, uuid, text, text, text, uuid",
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
  it("the header names the dedicated-role switch (no JWT, no signing secret), why the other writes are not under RLS, the paste order, the re-paste warning and the deploy order", () => {
    const head = M.slice(0, M.indexOf("-- ── Prerequisite"));
    const text = prose(head);
    expect(text).toContain("neither of which needs a JWT or its signing secret");
    expect(text).toContain("`intake_door` is a NOLOGIN role with no BYPASSRLS, granted to `authenticator` (the role PostgREST logs in as)");
    expect(text).toContain("set_config('role', 'intake_door', true); Postgres refuses a role switch only inside a SECURITY DEFINER function");
    expect(text).toContain("The role inherits no `TO authenticated` policy and adds no row to auth.users.");
    // the review fix: the earlier claim that RLS needs the JWT signing secret is gone
    expect(text).not.toMatch(/minting one needs the project's JWT signing secret/);
    expect(text).not.toMatch(/JWT secret in the server environment/);
    // each write left outside RLS says why, with the run that showed it
    expect(text).toContain("42P17 \"infinite recursion detected in policy\"");
    expect(text).toContain("documents_acl_select, a restrictive read policy for every role, hides even the link's own Draft");
    expect(text).toContain("projects-tab SEC-22, opened by this package");
    expect(text).toContain("WHERE THE PASTE CANNOT GRANT IT.");
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
  it("every function pins search_path; SECURITY DEFINER are exactly the bound-link reader, the two policy predicates and the four door functions that do not switch role — the new document and the quote are SECURITY INVOKER", () => {
    const heads = [...C.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\([^)]*\)[\s\S]*?AS \$\$/g)];
    expect(heads.map((m) => m[1])).toEqual([...HELPERS, "intake_door_bound", ...PREDICATES,
      "intake_door_create_document", "intake_door_submit_version", "intake_door_point_pending", "intake_door_promote",
      "intake_door_file_quote", "intake_door_append_redline"]);
    const definers = heads.filter((m) => /SECURITY DEFINER/.test(m[0])).map((m) => m[1]);
    // every SECURITY DEFINER function and every door function pins search_path (bind / unbind, INVOKER helpers, never did)
    for (const h of heads.filter((m) => definers.includes(m[1]) || (DOOR as readonly string[]).includes(m[1]))) {
      expect(h[0], h[1]).toMatch(/\nSET search_path = public\nAS \$\$/);
    }
    expect(definers).toEqual(["intake_door_bound", ...PREDICATES, "intake_door_submit_version", "intake_door_point_pending",
      "intake_door_promote", "intake_door_append_redline"]);
    for (const name of RLS_DOOR) expect(heads.find((m) => m[1] === name)![0], name).toMatch(/\nSECURITY INVOKER\nSET search_path = public\n/);
  });
  it("the six door functions are revoked from PUBLIC, anon and authenticated and granted to the service role alone; no intake_door_ function is ever granted to a client role", () => {
    for (const d of DOOR) {
      expect(C).toContain(`REVOKE ALL ON FUNCTION public.${d}(${SIG[d]}) FROM PUBLIC, anon, authenticated;`);
      expect(C).toContain(`GRANT EXECUTE ON FUNCTION public.${d}(${SIG[d]}) TO service_role;`);
    }
    expect(C).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.intake_door_\w+\([^)]*\) TO [^;]*(anon|authenticated|PUBLIC)/);
    // only the two policy predicates are the door role's to execute
    const toDoor = [...C.matchAll(/GRANT EXECUTE ON FUNCTION public\.(intake_door_\w+)\([^)]*\) TO intake_door;/g)].map((m) => m[1]);
    expect(toDoor).toEqual([...PREDICATES]);
  });
  it("the policy predicates are intake_door's alone and the bound-link reader no role's — not even the service role's", () => {
    for (const name of PREDICATES) {
      expect(C).toContain(`REVOKE ALL ON FUNCTION public.${name}(${SIG[name]}) FROM PUBLIC, anon, authenticated, service_role;`);
      expect(C).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(${SIG[name]}) TO intake_door;`);
    }
    expect(C).toContain("REVOKE ALL ON FUNCTION public.intake_door_bound() FROM PUBLIC, anon, authenticated, service_role;");
    expect(C).not.toMatch(/GRANT [^;]*intake_door_bound\(/);
  });
  it("each door function resolves the link from its token hash first — and the resolver refuses a signed-in caller (a NULL auth.uid() is trusted only because anon and authenticated cannot EXECUTE)", () => {
    for (const name of DOOR) expect(fn(name)).toMatch(/DECLARE\s*\n\s*v_door\s+jsonb\s*:= intake_door_resolve\(p_token_hash\);/);
    const resolve = fn("intake_door_resolve");
    expect(resolve).toMatch(/BEGIN\s*\n\s*IF auth\.uid\(\) IS NOT NULL THEN\s*\n\s*RAISE EXCEPTION 'intake_door: only the intake route, under the service key, opens the contractor door\.'\s*\n\s*USING ERRCODE = '42501';/);
  });
  it("the five helpers the door functions call are SECURITY INVOKER and the service role's alone (the INVOKER door functions run them as the service role)", () => {
    for (const name of HELPERS) {
      const head = between(M, `CREATE OR REPLACE FUNCTION public.${name}(`, "AS $$");
      expect(head, name).not.toMatch(/SECURITY DEFINER/);
      expect(C).toContain(`REVOKE ALL ON FUNCTION public.${name}(${SIG[name]}) FROM PUBLIC, anon, authenticated;`);
      expect(C).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(${SIG[name]}) TO service_role;`);
      expect(C).not.toMatch(new RegExp(`GRANT [^;]*${name}[^;]*TO (?!service_role;)`));
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
    expect(create).toContain("VALUES (v_id, v_org, v_lib, v_col, v_row.name, v_row.title, v_row.document_number, 'Draft',");
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
    expect(quote).toContain("VALUES (v_id, v_org, v_proj, 'quote', v_q.file_url, v_q.file_name, v_q.mime_type, v_door->>'company',");
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

describe("row-level security for the new document and the quote — the dedicated-role switch (GAP-401 item 1, review fix pass 2)", () => {
  const tx = () => between(C, "\nBEGIN;", "\nCOMMIT;");
  const roleBlock = () => between(C, "DO $$\nDECLARE\n  r record;", "END;\n$$;");
  /** Every GRANT … TO intake_door statement, whitespace-collapsed. */
  const toDoor = () => [...C.matchAll(/GRANT [^;]*? TO intake_door;/g)].map((m) => m[0].replace(/\s+/g, " "));
  const cols = (list: string) => list.split(",").map((c) => c.trim()).filter(Boolean);
  const insertCols = (body: string, table: string) => cols(between(body, `INSERT INTO ${table} (`, ")").slice(`INSERT INTO ${table} (`.length, -1));

  it("the role is made inside the one transaction: NOLOGIN, no BYPASSRLS, member of nothing — a pre-existing role that can log in, create roles or bypass RLS refuses the paste", () => {
    expect(tx()).toContain(roleBlock());
    expect(roleBlock()).toContain("CREATE ROLE intake_door NOLOGIN NOINHERIT;");
    expect(roleBlock()).toMatch(/IF NOT FOUND THEN\s*\n\s*CREATE ROLE intake_door NOLOGIN NOINHERIT;\s*\n\s*ELSIF r\.rolsuper OR r\.rolbypassrls OR r\.rolcanlogin OR r\.rolcreaterole OR r\.rolcreatedb OR r\.rolreplication THEN\s*\n\s*RAISE EXCEPTION/);
    // nothing grants intake_door another role's privileges, and only authenticator is made its member
    expect(C).not.toMatch(/GRANT (anon|authenticated|service_role|postgres|authenticator)[^;]* TO intake_door/);
    expect([...C.matchAll(/GRANT intake_door TO (\w+)/g)].map((m) => m[1])).toEqual(["authenticator"]);
    expect(C).not.toMatch(/ALTER ROLE intake_door/);
  });

  it("authenticator's membership, USAGE on schema auth and EXECUTE on auth.uid() are SOFT: a refusal leaves a notice and the final SELECT reports it, the paste still applies", () => {
    expect(roleBlock()).toMatch(/BEGIN\s*\n\s*GRANT intake_door TO authenticator;\s*\n\s*EXCEPTION WHEN OTHERS THEN\s*\n\s*RAISE NOTICE/);
    expect(roleBlock()).toMatch(/BEGIN\s*\n\s*GRANT USAGE ON SCHEMA auth TO intake_door;\s*\n\s*EXCEPTION WHEN OTHERS THEN\s*\n\s*RAISE NOTICE/);
    expect(roleBlock()).toMatch(/BEGIN\s*\n\s*GRANT EXECUTE ON FUNCTION auth\.uid\(\) TO intake_door;\s*\n\s*EXCEPTION WHEN OTHERS THEN\s*\n\s*RAISE NOTICE/);
  });

  it("the paste's four row-level-security rows ask intake_door_rls_gaps — the function the door functions decide by — so the probe can never read true while the door skips the switch (review fix pass 3, minor: the probe tested MEMBER, the door SET; review fix pass 5: the fourth row too)", () => {
    const tail = C.slice(C.indexOf("\nCOMMIT;"));
    expect(tail).toContain("AND NOT (intake_door_rls_gaps('authenticator', false) && ARRAY['role', 'switch']),");
    expect(tail).toContain("NOT (intake_door_rls_gaps('authenticator', true) && ARRAY['role', 'auth usage']),");
    expect(tail.match(/FROM unnest\(intake_door_rls_gaps\('authenticator', true\) \|\| intake_door_rls_gaps\('authenticator', false\)\) g/g)).toHaveLength(2);
    expect(tail).toContain("WHERE g = 'role' OR g LIKE 'execute %' OR g LIKE 'read %'),");
    expect(tail).toContain("WHERE g LIKE 'policy %'),");
    // no probe makes a role test of its own, and the version-dependent privilege (SET from PG16, MEMBER before) is written once, in rls_gaps
    expect(tail).not.toMatch(/pg_has_role\(/);
    expect(C.match(/CASE WHEN current_setting\('server_version_num'\)::int >= 160000 THEN 'SET' ELSE 'MEMBER' END/g)).toHaveLength(1);
    expect(fn("intake_door_rls_gaps")).toContain("pg_has_role(p_login, 'intake_door',\n                        CASE WHEN current_setting('server_version_num')::int >= 160000 THEN 'SET' ELSE 'MEMBER' END)");
    // and the runtime asks it for the session's own login
    expect(fn("intake_door_rls_ready")).toContain("SELECT cardinality(intake_door_rls_gaps(session_user, p_new_document)) = 0;");
    // every gap the function can report is read by one of the four rows
    const reported = [...fn("intake_door_rls_gaps").matchAll(/(?:ARRAY\[|\|\| |SELECT DISTINCT )'(\w+(?: \w+)?)/g)].map((m) => m[1]);
    expect(reported.sort()).toEqual(["auth usage", "execute ", "policy ", "read ", "role", "switch"].map((x) => x.trim()).sort());
  });

  it("the role holds exactly: USAGE on public and auth, column INSERT on documents and cost_documents, what the document rails read as the writer, EXECUTE on its two policy predicates and, by name, on what the policies for all roles call — no UPDATE, nothing on document_versions", () => {
    expect(toDoor().sort()).toEqual([
      "GRANT EXECUTE ON FUNCTION public.intake_door_may_create(uuid, uuid, uuid, uuid, text) TO intake_door;",
      "GRANT EXECUTE ON FUNCTION public.intake_door_may_quote(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid) TO intake_door;",
      "GRANT INSERT (created_by_name) ON documents TO intake_door;",
      "GRANT INSERT (id, org_id, library_id, collection_id, name, title, document_number, status, updated_at, uniqueness_key, authored_by_link_id) ON documents TO intake_door;",
      "GRANT INSERT (id, org_id, project_id, kind, file_url, file_name, mime_type, vendor_name, rfq_group, intake_link_id, party_id, status, created_by, file_hash) ON cost_documents TO intake_door;",
      "GRANT SELECT (document_id, source), DELETE ON document_assets TO intake_door;",
      "GRANT SELECT (id, org_id, acl_index) ON libraries TO intake_door;",
      "GRANT USAGE ON SCHEMA auth TO intake_door;",
      "GRANT USAGE ON SCHEMA public TO intake_door;",
      // review fix pass 3 (major): what the policies written for all roles call, by name
      "GRANT EXECUTE ON FUNCTION public.my_org_ids() TO intake_door;",
      "GRANT EXECUTE ON FUNCTION public.is_org_controller(uuid) TO intake_door;",
      "GRANT EXECUTE ON FUNCTION public.acl_index_denies(jsonb, uuid, uuid, text) TO intake_door;",
      "GRANT EXECUTE ON FUNCTION public.user_owns_project(uuid) TO intake_door;",
      "GRANT EXECUTE ON FUNCTION auth.uid() TO intake_door;",
    ].sort());
    expect(toDoor().join("\n")).not.toMatch(/UPDATE|document_versions|TRUNCATE|REFERENCES|TRIGGER|ALL/);
  });

  it("the granted INSERT columns are exactly the columns each door function inserts (created_by_name only where the live table has it)", () => {
    const docGrant = cols(toDoor().find((g) => /GRANT INSERT \(id, [^)]*\) ON documents/.test(g))!.match(/INSERT \(([^)]*)\)/)![1]);
    expect([...docGrant, "created_by_name"].sort()).toEqual(insertCols(fn("intake_door_create_document"), "documents").sort());
    expect(roleBlock()).toMatch(/AND column_name = 'created_by_name'\) THEN\s*\n\s*GRANT INSERT \(created_by_name\) ON documents TO intake_door;/);
    const quoteGrant = cols(toDoor().find((g) => / ON cost_documents /.test(g))!.match(/INSERT \(([^)]*)\)/)![1]);
    expect(quoteGrant.sort()).toEqual(insertCols(fn("intake_door_file_quote"), "cost_documents").sort());
  });

  it.each([["intake_door_create_document", "documents", "true", "new document"], ["intake_door_file_quote", "cost_documents", "false", "quote"]])(
    "%s switches to intake_door for its one INSERT (no RETURNING; the id chosen first) and back before anything else runs", (name, table, newDoc) => {
      const body = fn(name);
      expect(body).toContain("v_id   uuid  := gen_random_uuid();");
      expect(body).toContain(`v_rls  boolean := intake_door_rls_ready(${newDoc});`);
      expect(body).toContain("v_role text  := current_setting('role');");
      const insert = between(body, `INSERT INTO ${table} (`, ");\n");
      expect(insert).not.toMatch(/RETURNING/);
      expect(insert).toMatch(/VALUES \(v_id, /);
      expect(body).toContain(`IF v_rls THEN PERFORM set_config('role', 'intake_door', true); END IF;\n      INSERT INTO ${table} (`);
      expect(body).toContain(`${insert}      IF v_rls THEN PERFORM set_config('role', v_role, true); END IF;\n      EXIT;\n`);
      expect(body).toContain("    END;\n  END LOOP;\n  PERFORM intake_door_unbind(v_prev);\n  RETURN v_id;");
      // ONE insert statement (the fallback re-runs it, it is not a second copy)
      expect(body.match(/INSERT INTO/g)).toHaveLength(1);
      // the identity is bound before the switch
      expect(body.indexOf("v_prev := intake_door_bind(v_link, v_link, v_org, v_proj);")).toBeLessThan(body.indexOf("set_config('role', 'intake_door', true)"));
      expect(body.match(/set_config\('role'/g)).toHaveLength(3);
    });

  it.each([["intake_door_create_document", "new document", "documents"], ["intake_door_file_quote", "quote", "cost_documents"]])(
    "%s: a privilege the role lacks ('permission denied …'), or a policy that is not the door's own refusing it, runs the same INSERT once more with the bound identity alone and a WARNING — never a refused upload; the door's own policies' refusal and every other error are raised (review fix pass 3, major; review fix pass 5, major)", (name, what, table) => {
      const body = fn(name);
      const handler = between(body, "    EXCEPTION WHEN insufficient_privilege THEN\n", "\n    END;\n  END LOOP;");
      expect(body).toMatch(/\n  LOOP\n    BEGIN\n      IF v_rls THEN PERFORM set_config\('role', 'intake_door', true\); END IF;\n/);
      expect(handler).toBe([
        "    EXCEPTION WHEN insufficient_privilege THEN",
        "      IF v_rls THEN PERFORM set_config('role', v_role, true); END IF;",
        "      IF NOT v_rls",
        `         OR SQLERRM IN ('new row violates row-level security policy for table "${table}"',`,
        `                        'new row violates row-level security policy "${table}_intake_door_scope" for table "${table}"')`,
        "         OR NOT (SQLERRM LIKE 'permission denied%' OR SQLERRM LIKE 'new row violates row-level security policy \"%') THEN",
        "        RAISE;",
        "      END IF;",
        `      RAISE WARNING '${name}: % — this ${what} is written with the bound identity alone, without row-level security (projects-tab SEC-22).', SQLERRM;`,
        "      v_rls := false;",
        "    END;",
        "  END LOOP;",
      ].join("\n"));
      // nothing else is caught: no OTHERS handler, no other condition
      expect(body.match(/EXCEPTION WHEN/g)).toHaveLength(1);
      expect(body).not.toMatch(/WHEN OTHERS/);
      // Postgres's own message for a privilege gap starts "permission denied"; an RLS refusal starts "new row violates", and
      // no migration's own RAISE starts with either (so no guard's refusal is ever mistaken for a gap or a policy's refusal)
      for (const f of numbered()) expect(code(mig(f)), f).not.toMatch(/RAISE EXCEPTION\s+'(permission denied|new row violates)/i);
      // the door's own refusals are the ones Postgres raises for THIS table's door policies: no permissive policy admitted
      // the row (Postgres names none — the door's permissive policy is the one a link can pass), or the scope policy, named
      // exactly as section 9 creates it on that table
      expect(C).toContain(`CREATE POLICY ${table}_intake_door_scope ON ${table}\n  AS RESTRICTIVE FOR INSERT TO intake_door`);
      expect(C).toContain(`CREATE POLICY ${table}_intake_door_insert ON ${table}\n  AS PERMISSIVE FOR INSERT TO intake_door`);
    });

  it("no other function switches role (the submission, pointer, promote and redline stay SECURITY DEFINER, where Postgres forbids it)", () => {
    for (const name of DOOR.filter((d) => !(RLS_DOOR as readonly string[]).includes(d))) {
      expect(fn(name), name).not.toMatch(/set_config\('role'/);
    }
    expect(C.match(/set_config\('role', 'intake_door', true\)/g)).toHaveLength(2);
  });

  it("intake_door_rls_ready asks intake_door_rls_gaps for the session's login: the role exists, the login may SET it (MEMBER before PG16), a new document may resolve auth.uid(), and the role may EXECUTE and read what the LIVE INSERT policies use (review fix pass 3, major)", () => {
    expect(fn("intake_door_rls_ready")).toContain("SELECT cardinality(intake_door_rls_gaps(session_user, p_new_document)) = 0;");
    const g = fn("intake_door_rls_gaps");
    expect(g).toMatch(/\nLANGUAGE plpgsql\nSTABLE\nSET search_path = public\nAS \$\$/);
    expect(g).toContain("IF v_door IS NULL THEN\n    RETURN ARRAY['role'];");
    expect(g).toContain("IF to_regrole(p_login) IS NULL\n     OR NOT pg_has_role(p_login, 'intake_door',");
    expect(g).toContain("IF p_new_document AND (to_regnamespace('auth') IS NULL OR NOT has_schema_privilege('intake_door', 'auth', 'USAGE')) THEN");
    // the policies are read from the catalogs at run time: INSERT and ALL policies, for every role or intake_door, of the door's table
    expect(g).toContain("v_table oid := CASE WHEN p_new_document THEN to_regclass('public.documents') ELSE to_regclass('public.cost_documents') END;");
    expect(g.match(/JOIN pg_depend d ON d\.classid = 'pg_policy'::regclass AND d\.objid = pol\.oid AND d\.refclassid = 'pg_(proc|operator|class)'::regclass/g)).toHaveLength(3);
    expect(g.match(/WHERE pol\.polrelid = v_table AND pol\.polcmd IN \('a', '\*'\)\n\s+AND \(0::oid = ANY \(pol\.polroles\) OR v_door = ANY \(pol\.polroles\)\)/g)).toHaveLength(3);
    expect(g).toContain("SELECT to_regprocedure('auth.uid()')::oid WHERE p_new_document AND to_regnamespace('auth') IS NOT NULL) f");
    expect(g).toContain("WHERE f.fn IS NOT NULL AND NOT has_function_privilege('intake_door', f.fn, 'EXECUTE')");
    expect(g).toContain("AND d.refobjid <> pol.polrelid");
    expect(g).toContain("CASE WHEN d.refobjsubid > 0 THEN NOT has_column_privilege('intake_door', d.refobjid, d.refobjsubid::smallint, 'SELECT')");
    expect(g).toContain("ELSE NOT has_any_column_privilege('intake_door', d.refobjid, 'SELECT') END");
  });

  it("four policies TO intake_door, INSERT only: a permissive and a restrictive pair on documents and on cost_documents, each re-created idempotently and reading the predicate with the row's own columns", () => {
    const pols = [...C.matchAll(/CREATE POLICY (\w+) ON (\w+)\s*\n\s*AS (PERMISSIVE|RESTRICTIVE) FOR (\w+) TO (\w+)\s*\n\s*WITH CHECK \((\w+)\(([^)]*)\)\);/g)]
      .map((m) => ({ name: m[1], table: m[2], kind: m[3], cmd: m[4], to: m[5], pred: m[6], args: m[7] }));
    expect(pols.map((p) => `${p.table}:${p.kind}:${p.cmd}:${p.to}:${p.pred}`)).toEqual([
      "documents:PERMISSIVE:INSERT:intake_door:intake_door_may_create",
      "documents:RESTRICTIVE:INSERT:intake_door:intake_door_may_create",
      "cost_documents:PERMISSIVE:INSERT:intake_door:intake_door_may_quote",
      "cost_documents:RESTRICTIVE:INSERT:intake_door:intake_door_may_quote",
    ]);
    for (const p of pols) {
      expect(C, p.name).toContain(`DROP POLICY IF EXISTS ${p.name} ON ${p.table};\nCREATE POLICY ${p.name} ON ${p.table}`);
      expect(cols(p.args).length).toBe(cols(SIG[p.pred]).length);
    }
    expect(pols.find((p) => p.table === "documents")!.args).toBe("org_id, library_id, collection_id, authored_by_link_id, status");
    expect(pols.find((p) => p.table === "cost_documents")!.args).toBe("org_id, project_id, kind, intake_link_id, file_url, party_id, vendor_name, rfq_group, status, created_by");
    // the file creates no other policy, and none on document_versions
    expect(C.match(/CREATE POLICY/g)).toHaveLength(4);
    expect(C).not.toMatch(/ON document_versions[^;]*TO intake_door/);
  });

  it("the policies read the BOUND link, re-read live: the role is intake_door, the claims are the door's, sub is the link, the link neither revoked nor expired, its project open", () => {
    const b = fn("intake_door_bound");
    expect(b).toContain("IF COALESCE(current_setting('role', true), '') <> 'intake_door' OR v_text IS NULL THEN");
    expect(b).toContain("IF v_claims->>'role' IS DISTINCT FROM 'intake_door'");
    expect(b).toContain("OR auth.uid() IS DISTINCT FROM (v_claims->>'intake_link_id')::uuid THEN");
    expect(b).toContain("SELECT * INTO v_link FROM project_intake_links WHERE id = (v_claims->>'intake_link_id')::uuid;");
    expect(b).toContain("IF NOT FOUND OR v_link.revoked_at IS NOT NULL OR (v_link.expires_at IS NOT NULL AND v_link.expires_at < NOW())");
    expect(b).toContain("OR v_link.org_id::text IS DISTINCT FROM v_claims->>'org_id'");
    expect(b).toContain("OR v_link.project_id::text IS DISTINCT FROM v_claims->>'project_id' THEN");
    const closed = b.match(/v_project\.status IN \(([^)]+)\) THEN/)![1].split(",").map((x) => x.trim().replace(/'/g, ""));
    expect(closed.sort()).toEqual([...CLOSED_PROJECT_STATUSES].sort());
    const create = fn("intake_door_may_create");
    for (const limb of ["AND v_door->>'purpose' IS DISTINCT FROM 'quote'", "AND p_org::text = v_door->>'org_id'", "AND p_library::text = v_door->>'library_id'",
      "AND p_collection::text = v_door->>'collection_id'", "AND p_author::text = v_door->>'link_id'", "AND p_status = 'Draft'",
      "AND EXISTS (SELECT 1 FROM collections c WHERE c.id = p_collection AND c.org_id = p_org AND c.library_id = p_library)"]) {
      expect(create, limb).toContain(limb);
    }
    const quote = fn("intake_door_may_quote");
    for (const limb of ["AND v_door->>'purpose' = 'quote'", "AND p_project::text = v_door->>'project_id'", "AND p_kind = 'quote'", "AND p_link::text = v_door->>'link_id'",
      "AND p_file_url ~ ('^orgs/' || (v_door->>'org_id') || '/project-costs/' || (v_door->>'project_id') || '/quote-[^/]+$')",
      "OR EXISTS (SELECT 1 FROM project_parties pp WHERE pp.id = p_party AND pp.project_id = p_project AND pp.org_id = p_org))",
      "AND p_vendor IS NOT DISTINCT FROM v_door->>'company'", "AND p_rfq IS NOT DISTINCT FROM v_door->>'rfq_group'",
      "AND p_status = 'draft'", "AND p_created_by IS NULL,"]) {
      expect(quote, limb).toContain(limb);
    }
    // a predicate that cannot decide answers false, never NULL
    for (const name of PREDICATES) expect(fn(name)).toMatch(/RETURN COALESCE\([\s\S]*,\s*\n\s*false\);/);
  });
});

// ── Review fix pass 3 (major): intake_door's EXECUTE on what the policies
// written for all roles call is held BY NAME, and must stay held. DRLS-16's
// rule re-creates SECURITY DEFINER helpers with REVOKE … FROM PUBLIC; a later
// file doing that to one of these without giving it back to intake_door
// would send the door's new documents and quotes to the bound-identity
// fallback (never a refused upload, since 20261184 degrades) — this test
// makes that file fail here instead, so its author re-grants.
/** The helpers the INSERT policies (and the INVOKER document triggers) call, as 20261184 grants them to intake_door. */
const HELD: ReadonlyArray<{ schema: string; name: string }> = [
  { schema: "public", name: "my_org_ids" }, { schema: "public", name: "is_org_controller" },
  { schema: "public", name: "acl_index_denies" }, { schema: "public", name: "user_owns_project" },
  { schema: "auth", name: "uid" },
];
/** What a migration's SQL takes away from intake_door: a held helper's EXECUTE revoked from PUBLIC (by name or by a
 *  schema-wide sweep), or the helper dropped (a re-create starts from the default ACL), without the same file granting
 *  it to intake_door afterwards. */
function strippedFromDoor(sql: string): string[] {
  const stmts = code(sql).split(";").map((x) => x.replace(/\s+/g, " ").trim());
  const out: string[] = [];
  const regrantedAfter = (i: number, h: { schema: string; name: string }) => stmts.slice(i + 1).some((g) =>
    new RegExp(`^GRANT (ALL|EXECUTE)\\b[^;]*\\bON (FUNCTION|ROUTINE) [^;]*\\b${h.name}\\s*\\([^;]* TO [^;]*\\bintake_door\\b`, "i").test(g)
    || new RegExp(`^GRANT (ALL|EXECUTE)\\b[^;]*\\bON ALL (FUNCTIONS|ROUTINES) IN SCHEMA [^;]*\\b${h.schema}\\b[^;]* TO [^;]*\\bintake_door\\b`, "i").test(g));
  stmts.forEach((st, i) => {
    for (const h of HELD) {
      const byName = new RegExp(`^REVOKE\\b[^;]*\\bON (FUNCTION|ROUTINE) [^;]*\\b${h.name}\\s*\\([^;]* FROM [^;]*\\bPUBLIC\\b`, "i").test(st);
      const sweep = new RegExp(`^REVOKE\\b[^;]*\\bON ALL (FUNCTIONS|ROUTINES) IN SCHEMA [^;]*\\b${h.schema}\\b[^;]* FROM [^;]*\\bPUBLIC\\b`, "i").test(st);
      const dropped = new RegExp(`^DROP (FUNCTION|ROUTINE) (IF EXISTS )?[^;]*\\b${h.name}\\s*\\(`, "i").test(st);
      if ((byName || sweep || dropped) && !regrantedAfter(i, h)) out.push(`${h.schema}.${h.name}: ${st.slice(0, 120)}`);
    }
  });
  return out;
}

describe("intake_door keeps EXECUTE on what the policies for all roles call (review fix pass 3, major)", () => {
  it("20261184 grants each by name — the four public helpers where they exist, auth.uid() soft", () => {
    for (const h of HELD.filter((x) => x.schema === "public")) {
      expect(C).toMatch(new RegExp(`IF to_regprocedure\\('public\\.${h.name}\\([^']*\\)'\\) IS NOT NULL THEN\\s*\\n\\s*GRANT EXECUTE ON FUNCTION public\\.${h.name}\\([^)]*\\) TO intake_door;`));
    }
    expect(C).toContain("GRANT EXECUTE ON FUNCTION auth.uid() TO intake_door;");
    // each is a function a policy of the sequence calls (the scratch run's pg_depend listed exactly these for the
    // INSERT and ALL policies of documents and cost_documents; intake_door_rls_gaps re-reads the live ones)
    const sources = [readFileSync(join(root, "supabase", "schema.sql"), "utf8"), ...numbered().filter((x) => x <= FILE).map(mig)].map(code).join("\n");
    for (const h of HELD) expect(sources, h.name).toMatch(new RegExp(`CREATE POLICY[^;]*\\b${h.name}\\(`));
  });
  it("no migration after 20261184 revokes EXECUTE on them from PUBLIC, sweeps a schema's functions from PUBLIC, or drops one, without granting it back to intake_door", () => {
    const later = numbered().filter((f) => f > FILE);
    for (const f of later) expect(strippedFromDoor(mig(f)), f).toEqual([]);
  });
  it("the detector: a DRLS-16-style REVOKE FROM PUBLIC is caught, the same with a re-grant to intake_door is not, a schema sweep and a DROP are caught", () => {
    expect(strippedFromDoor("REVOKE ALL ON FUNCTION public.is_org_controller(uuid) FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public.is_org_controller(uuid) TO authenticated;")).toHaveLength(1);
    expect(strippedFromDoor("REVOKE EXECUTE ON FUNCTION my_org_ids() FROM public;")).toHaveLength(1);
    expect(strippedFromDoor("REVOKE ALL ON FUNCTION public.is_org_controller(uuid) FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public.is_org_controller(uuid) TO authenticated, intake_door;")).toEqual([]);
    expect(strippedFromDoor("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;")).toHaveLength(4);
    expect(strippedFromDoor("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;\nGRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO intake_door;")).toEqual([]);
    expect(strippedFromDoor("DROP FUNCTION IF EXISTS public.user_owns_project(uuid);\nCREATE FUNCTION public.user_owns_project(p uuid) RETURNS boolean LANGUAGE sql AS $$ select true $$;")).toHaveLength(1);
    // revoking from another role, or touching another function, is not the door's concern
    expect(strippedFromDoor("REVOKE ALL ON FUNCTION public.is_org_controller(uuid) FROM anon;")).toEqual([]);
    expect(strippedFromDoor("REVOKE ALL ON FUNCTION public.is_org_controller_for(uuid, uuid) FROM PUBLIC;")).toEqual([]);
    // and 20261184 itself would pass it (it only grants)
    expect(strippedFromDoor(M)).toEqual([]);
  });
});

// ── Review fix pass 4 (major), revised by review fix pass 5 (major): a
// RESTRICTIVE INSERT / ALL policy written for every role judges the door's
// INSERT as intake_door exactly as it judges a member's, and one the link's
// identity cannot satisfy (a membership test, say) would REFUSE that write —
// an upload that works today would answer 500. Fix pass 4 detected one only
// after the fact (a paste row). Since fix pass 5 intake_door_rls_gaps names
// it ('policy <name>') BEFORE the switch, so readiness is false and that
// table's write keeps the bound identity under the service key — every
// trigger guard still judging it, the upload filed as today — and the
// paste's fourth row reads that gap. A refusal the check could not see (a
// policy made since it ran, one for a role intake_door inherits) falls back
// the same way, with a WARNING; only the door's own policies refuse after
// the switch. This test still fails a later migration that adds such a
// policy without saying how intake_door is treated (a TO clause that leaves
// it out, a predicate naming it, or a comment `-- intake_door: <policy> …` in
// the same file), because the door's new documents or quotes would then
// leave row-level security unannounced.
const DOOR_TABLE = String.raw`(?:public\.)?"?(documents|cost_documents)"?`;
const CREATE_ON_DOOR_TABLE = new RegExp(String.raw`\bCREATE POLICY "?(\w+)"? ON ${DOOR_TABLE} (.*)$`, "i");
const ALTER_ON_DOOR_TABLE = new RegExp(String.raw`\bALTER POLICY "?(\w+)"? ON ${DOOR_TABLE} (.*)$`, "i");
/** CREATE POLICY's optional clauses, in the grammar's order, after "ON <table> ". */
const POLICY_TAIL = /^(?:AS (PERMISSIVE|RESTRICTIVE)\s*)?(?:FOR (ALL|SELECT|INSERT|UPDATE|DELETE)\s*)?(?:TO ((?:(?!\bUSING\b|\bWITH CHECK\b).)+?)\s*)?((?:USING|WITH CHECK)\b.*)?$/i;
/** ALTER POLICY's optional clauses after "ON <table> ". */
const ALTER_TAIL = /^(?:TO ((?:(?!\bUSING\b|\bWITH CHECK\b).)+?)\s*)?((?:USING|WITH CHECK)\b.*)?$/i;
const appliesToDoor = (to: string | undefined) => !to
  || to.split(",").map((r) => r.trim().replace(/"/g, "").toLowerCase()).some((r) => r === "public" || r === "intake_door");
/** The restrictive INSERT / ALL policies on documents or cost_documents that schema.sql and every migration create. */
let restrictiveKnown: Set<string> | null = null;
function restrictiveDoorPolicies(): Set<string> {
  if (restrictiveKnown) return restrictiveKnown;
  const out = new Set<string>();
  const sources = [readFileSync(join(root, "supabase", "schema.sql"), "utf8"), ...numbered().map(mig)];
  for (const sql of sources) {
    for (const st of code(sql).split(";").map((x) => x.replace(/\s+/g, " ").trim())) {
      const c = /POLICY/i.test(st) ? st.match(CREATE_ON_DOOR_TABLE) : null;
      const t = c?.[3].match(POLICY_TAIL);
      if (c && t && /RESTRICTIVE/i.test(t[1] ?? "") && /^(ALL|INSERT)$/i.test(t[2] ?? "ALL")) out.add(`${c[2]}.${c[1]}`);
    }
  }
  restrictiveKnown = out;
  return out;
}
/** What a migration's SQL adds that may refuse the door's INSERT as intake_door: a RESTRICTIVE policy FOR INSERT or
 *  ALL (or no FOR: ALL) on documents or cost_documents, with no TO clause or one naming PUBLIC or intake_door — made
 *  directly, inside a DO block, or by format() in a file that names either table — or an ALTER POLICY re-writing one
 *  already restrictive, unless the file says how intake_door is treated. */
function restrictsDoor(sql: string, known: ReadonlySet<string> = restrictiveDoorPolicies()): string[] {
  const stated = (name: string) => new RegExp(String.raw`--\s*intake_door:\s*"?${name}"?\b`, "i").test(sql);
  const out: string[] = [];
  const body = code(sql);
  const namesDoorTable = /'(?:public\.)?(?:cost_)?documents'/i.test(body);
  for (const st of body.split(";").map((x) => x.replace(/\s+/g, " ").trim())) {
    if (!/POLICY/i.test(st)) continue;
    const c = st.match(CREATE_ON_DOOR_TABLE);
    if (c) {
      const t = c[3].match(POLICY_TAIL);
      const [kind, cmd, to, predicate] = t ? [t[1], t[2], t[3], t[4] ?? ""] : ["RESTRICTIVE", undefined, undefined, c[3]];
      if (!/RESTRICTIVE/i.test(kind ?? "") || !/^(ALL|INSERT)$/i.test(cmd ?? "ALL") || !appliesToDoor(to)) continue;
      if (/\bintake_door/i.test(predicate) || stated(c[1])) continue;
      out.push(`${c[2]}.${c[1]}: ${st.slice(0, 140)}`);
      continue;
    }
    const a = st.match(ALTER_ON_DOOR_TABLE);
    if (a) {
      if (!known.has(`${a[2]}.${a[1]}`) || /^RENAME\b/i.test(a[3])) continue;
      const t = a[3].match(ALTER_TAIL);
      const [to, predicate] = t ? [t[1], t[2] ?? ""] : [undefined, a[3]];
      if (!appliesToDoor(to) || /\bintake_door/i.test(predicate) || stated(a[1])) continue;
      out.push(`${a[2]}.${a[1]} (altered): ${st.slice(0, 140)}`);
      continue;
    }
    const f = st.match(/\bCREATE POLICY %I\w* ON %I (.*)$/i);
    if (f && namesDoorTable && !/--\s*intake_door:/i.test(sql)) {
      const t = f[1].match(POLICY_TAIL);
      if (t && /RESTRICTIVE/i.test(t[1] ?? "") && /^(ALL|INSERT)$/i.test(t[2] ?? "ALL") && appliesToDoor(t[3])) {
        out.push(`format(): ${st.slice(0, 140)}`);
      }
    }
  }
  return out;
}

describe("a restrictive policy for every role that the link may fail is a gap — found before the switch, reported at the paste, and refused in later migrations (review fix pass 4, major; review fix pass 5, major)", () => {
  const tail = () => C.slice(C.indexOf("\nCOMMIT;"));
  /** The predicate fix pass 4's fourth row held; since fix pass 5 it is a limb of intake_door_rls_gaps (once in the file). */
  const POLICY_LIMB = [
    "v_gaps := v_gaps || ARRAY(\n    SELECT DISTINCT 'policy ' || pol.polname::text\n      FROM pg_policy pol",
    "WHERE pol.polrelid = v_table AND NOT pol.polpermissive AND pol.polcmd IN ('a', '*')",
    "AND (0::oid = ANY (pol.polroles) OR v_door = ANY (pol.polroles))",
    "AND NOT ((pol.polrelid, pol.polname) IN ((to_regclass('public.documents'), 'documents_intake_door_scope'),",
    "(to_regclass('public.cost_documents'), 'cost_documents_intake_door_scope'))",
    "AND pol.polroles = ARRAY[v_door])",
    "AND NOT (pol.polrelid = to_regclass('public.documents') AND pol.polname = 'documents_deny_upload_guard'",
    "AND NOT EXISTS (SELECT 1 FROM pg_depend d",
    "WHERE d.classid = 'pg_policy'::regclass AND d.objid = pol.oid",
    "AND d.refobjid IN (pol.polrelid, to_regclass('public.libraries')))",
    "AND d.refobjid IN (to_regprocedure('auth.uid()'), to_regprocedure('public.is_org_controller(uuid)'),",
    "to_regprocedure('public.acl_index_denies(jsonb, uuid, uuid, text)'))))))\n     ORDER BY 1);",
  ];
  it("intake_door_rls_gaps names each restrictive INSERT / ALL policy of the door's table for PUBLIC or intake_door, beyond documents_deny_upload_guard (only in the repository's shape) and the door's own scope policy, as 'policy <name>' — so intake_door_rls_ready is false and the write keeps the bound identity (the shape before row-level security), never a refused upload", () => {
    const g = fn("intake_door_rls_gaps");
    const limb = between(g, "  v_gaps := v_gaps || ARRAY(\n    SELECT DISTINCT 'policy '", "     ORDER BY 1);");
    for (const piece of POLICY_LIMB) expect(limb, piece).toContain(piece.replace(/^v_gaps := v_gaps \|\| ARRAY\(\n    /, ""));
    // it is the last limb, read from the catalogs (no deparsed text), and the function answers every gap it found
    expect(g.indexOf("SELECT DISTINCT 'policy '")).toBeGreaterThan(g.indexOf("SELECT DISTINCT 'read '"));
    expect(limb).not.toMatch(/pg_policies|pg_get_expr|with_check|qual/);
    expect(g).toMatch(/ORDER BY 1\);\n  RETURN v_gaps;\nEND;/);
    // the predicate is written once — in the function the door decides by — and the paste reads that function, never a copy
    expect(C.match(/'documents_deny_upload_guard'/g)).toHaveLength(1);
    expect(C.match(/pg_depend d\s+WHERE d\.classid = 'pg_policy'::regclass AND d\.objid = pol\.oid/g)).toHaveLength(1);
    // the door functions decide by it before the switch
    for (const [name, newDoc] of [["intake_door_create_document", "true"], ["intake_door_file_quote", "false"]]) {
      expect(fn(name)).toContain(`v_rls  boolean := intake_door_rls_ready(${newDoc});`);
    }
    expect(M).toMatch(/'policy <name>'' for a RESTRICTIVE INSERT or ALL policy of that table for every role \(or intake_door\) the link may fail/);
  });
  it("the paste's fourth row-level-security row reads that gap from intake_door_rls_gaps for authenticator — false means the door's new documents or quotes keep the bound identity, filed as before (no 'send back at once', no 500)", () => {
    const row = between(tail(), "SELECT 'row-level security for both: no restrictive INSERT or ALL policy", "       NULL\nUNION ALL");
    expect(row).toContain("by the door''s own test");
    expect(row).toContain("keep the bound identity alone, filed as before, until it says how it treats intake_door (SEC-22)");
    expect(row).toContain("NOT EXISTS (SELECT 1\n                     FROM unnest(intake_door_rls_gaps('authenticator', true) || intake_door_rls_gaps('authenticator', false)) g\n                    WHERE g LIKE 'policy %'),");
    expect(row).not.toMatch(/pg_policy|pg_depend|500|at once|REFUSES/);
    // it is a probe (ok, n NULL), the fourth of the row-level-security rows
    const rls = [...tail().matchAll(/SELECT 'row-level security for /g)].map((m) => m.index!);
    expect(rls).toHaveLength(4);
    expect(tail().indexOf("SELECT 'row-level security for both: no restrictive INSERT")).toBe(rls[3]);
    // the header: a policy the link may fail is a gap, not a refusal; four rows, each filed as before
    const head = prose(M.slice(0, M.indexOf("-- ── Prerequisite")));
    expect(head).toContain("A POLICY THE LINK MAY FAIL IS A GAP TOO.");
    expect(head).toContain("would refuse that write — an upload that works today would answer 500. So intake_door_rls_gaps names each RESTRICTIVE INSERT or ALL policy");
    expect(head).toContain("After the switch only the door's own policies refuse its write (the route answers 500): they are the link's boundary.");
    expect(head).toContain("if one of the four \"row-level security\" rows reads false, the paste still applied and the door's uploads are filed as before");
    expect(head).not.toContain("A POLICY'S REFUSAL IS NOT A GAP");
    expect(head).not.toMatch(/the fourth at once|instead of being stepped around/);
    expect(tail()).not.toMatch(/send that row back at once/);
  });
  it("its exclusions are exactly what the sequence holds: up to 20261184 the one restrictive INSERT / ALL policy for every role on these tables is documents_deny_upload_guard, which reads only libraries, auth.uid, is_org_controller and acl_index_denies", () => {
    const upTo = [readFileSync(join(root, "supabase", "schema.sql"), "utf8"), ...numbered().filter((f) => f <= FILE).map(mig)];
    const found = upTo.flatMap((sql) => restrictsDoor(sql)).map((x) => x.slice(0, x.indexOf(":")));
    expect([...new Set(found)]).toEqual(["documents.documents_deny_upload_guard"]);
    // its newest definition: the predicate the paste's pg_depend limb admits
    const defs = upTo.map(code).flatMap((sql) => sql.split(";")).filter((st) => /CREATE POLICY documents_deny_upload_guard ON documents/.test(st));
    const newest = defs[defs.length - 1].replace(/\s+/g, " ");
    expect(newest).toContain("AS RESTRICTIVE FOR INSERT WITH CHECK (");
    expect([...newest.matchAll(/([\w.]+)\(/g)].map((m) => m[1]).filter((n) => !/^(CHECK|EXISTS)$/i.test(n)).sort())
      .toEqual(["acl_index_denies", "auth.uid", "auth.uid", "is_org_controller"]);
    expect([...newest.matchAll(/\bFROM (\w+)/g)].map((m) => m[1])).toEqual(["libraries"]);
    // and the scope policies the row also excludes are this file's own, TO intake_door
    expect(C).toContain("CREATE POLICY documents_intake_door_scope ON documents\n  AS RESTRICTIVE FOR INSERT TO intake_door");
    expect(C).toContain("CREATE POLICY cost_documents_intake_door_scope ON cost_documents\n  AS RESTRICTIVE FOR INSERT TO intake_door");
  });
  it("no migration after 20261184 adds or re-writes a restrictive INSERT / ALL policy on documents or cost_documents that applies to intake_door without saying how intake_door is treated (it would take the door's writes on that table off row-level security, unannounced)", () => {
    for (const f of numbered().filter((x) => x > FILE)) expect(restrictsDoor(mig(f)), f).toEqual([]);
  });
  it("the detector: the reviewer's hardening policy is caught, as are ALL / no FOR, TO public / intake_door, one in a DO block, a format() one in a file naming the table, a re-created upload guard and an ALTER of it; a TO clause leaving intake_door out, a predicate or a comment naming it, a permissive or an UPDATE policy are not", () => {
    const hardening = "CREATE POLICY cost_documents_member_insert ON cost_documents AS RESTRICTIVE FOR INSERT WITH CHECK (org_id IN (SELECT my_org_ids()));";
    expect(restrictsDoor(hardening)).toHaveLength(1);
    expect(restrictsDoor(hardening.replace("FOR INSERT", "FOR ALL"))).toHaveLength(1);
    expect(restrictsDoor(hardening.replace(" FOR INSERT", ""))).toHaveLength(1);
    expect(restrictsDoor(hardening.replace("FOR INSERT", "FOR INSERT TO public"))).toHaveLength(1);
    expect(restrictsDoor(hardening.replace("FOR INSERT", "FOR INSERT TO authenticated, intake_door"))).toHaveLength(1);
    expect(restrictsDoor(hardening.replace("ON cost_documents", "ON public.documents"))).toHaveLength(1);
    expect(restrictsDoor(`DO $$\nBEGIN\n  ${hardening}\nEND $$;`)).toHaveLength(1);
    expect(restrictsDoor("DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['documents'] LOOP\n  EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR INSERT WITH CHECK (%s)', t || '_x', t, 'is_org_controller(org_id)');\nEND LOOP; END $$;")).toHaveLength(1);
    const guard = between(mig("20260901_db_hard_enforcement.sql"), "CREATE POLICY documents_deny_upload_guard ON documents", ");\n");
    expect(restrictsDoor(guard)).toHaveLength(1);
    expect(restrictsDoor("ALTER POLICY documents_deny_upload_guard ON documents WITH CHECK (org_id IN (SELECT my_org_ids()));")).toHaveLength(1);
    // not caught
    expect(restrictsDoor(hardening.replace("FOR INSERT", "FOR INSERT TO authenticated"))).toEqual([]);
    expect(restrictsDoor(hardening.replace("(org_id IN", "(current_user = 'intake_door' OR org_id IN"))).toEqual([]);
    expect(restrictsDoor(`-- intake_door: cost_documents_member_insert — the door's quote is admitted by its own scope policy\n${hardening}`)).toEqual([]);
    expect(restrictsDoor(hardening.replace("AS RESTRICTIVE ", ""))).toEqual([]);
    expect(restrictsDoor(hardening.replace("FOR INSERT WITH CHECK", "FOR UPDATE USING"))).toEqual([]);
    expect(restrictsDoor(hardening.replace("ON cost_documents", "ON document_versions"))).toEqual([]);
    expect(restrictsDoor("ALTER POLICY documents_org_access ON documents USING (org_id IN (SELECT my_org_ids()));")).toEqual([]);
    expect(restrictsDoor("ALTER POLICY documents_deny_upload_guard ON documents RENAME TO documents_upload_guard;")).toEqual([]);
    expect(restrictsDoor(mig("20261045_rp_phase6_admin_gates_team_fk_reviewer_independence.sql"))).toEqual([]);
  });
});

describe("the promote publishes an ALLOW-LISTED version (review fix pass 2, minor)", () => {
  const ALLOW = ["revision_label", "file_url", "file_type", "size", "change_log", "created_by_name", "file_hash"];
  it("publish_revision's p_version is a jsonb_build_object of exactly the route's seven fields and provenance 'external' — nothing from the caller passes through", () => {
    const promote = fn("intake_door_promote");
    const built = between(promote, "p_version => jsonb_build_object(", "'provenance', 'external'),");
    const pairs = [...built.matchAll(/'(\w+)', p_version->'(\w+)'/g)].map((m) => [m[1], m[2]]);
    expect(pairs.map((p) => p[0])).toEqual(ALLOW);
    for (const [k, v] of pairs) expect(v).toBe(k);
    expect([...built.matchAll(/\n\s*'(\w+)', /g)].map((m) => m[1])).toEqual([...ALLOW, "provenance"]);
    expect(promote).not.toMatch(/p_version \|\|/);
    for (const off of ["change_type", "issue_type", "moc_reference", "reverted_from_version_id", "related_ticket_id", "source_file_key", "source_file_name", "drawn_by_name", "checked_by_name", "approved_by_name"]) {
      expect(promote, off).not.toContain(`'${off}'`);
    }
  });
  it("the route sends no field the allow-list drops (so the promote publishes what the route meant), and its provenance is 'external' either way", () => {
    const route = between(ROUTE, "  const version = {", "  };");
    const keys = [...route.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]);
    expect(keys.filter((k) => k !== "provenance").sort()).toEqual([...ALLOW].sort());
    expect(route).toContain('provenance: "external",');
  });
});
