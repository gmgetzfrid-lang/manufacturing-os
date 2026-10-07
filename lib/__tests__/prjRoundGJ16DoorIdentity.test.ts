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
const HELPERS = ["intake_door_resolve", "intake_door_bind", "intake_door_unbind", "intake_door_rls_ready"] as const;
const SIG: Record<string, string> = {
  intake_door_resolve: "text",
  intake_door_bind: "uuid, uuid, uuid, uuid",
  intake_door_unbind: "jsonb",
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
    expect(heads.map((m) => m[1])).toEqual([...HELPERS.slice(0, 3), "intake_door_rls_ready", "intake_door_bound", ...PREDICATES,
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
  it("the four helpers the door functions call are SECURITY INVOKER and the service role's alone (the INVOKER door functions run them as the service role)", () => {
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

  it("authenticator's membership and USAGE on schema auth are SOFT: a refusal leaves a notice and the final SELECT reports it, the paste still applies", () => {
    expect(roleBlock()).toMatch(/BEGIN\s*\n\s*GRANT intake_door TO authenticator;\s*\n\s*EXCEPTION WHEN OTHERS THEN\s*\n\s*RAISE NOTICE/);
    expect(roleBlock()).toMatch(/BEGIN\s*\n\s*GRANT USAGE ON SCHEMA auth TO intake_door;\s*\n\s*EXCEPTION WHEN OTHERS THEN\s*\n\s*RAISE NOTICE/);
    const tail = C.slice(C.indexOf("\nCOMMIT;"));
    expect(tail).toContain("to_regrole('authenticator') IS NOT NULL AND pg_has_role('authenticator', 'intake_door', 'MEMBER')");
    expect(tail).toContain("to_regnamespace('auth') IS NOT NULL AND has_schema_privilege('intake_door', 'auth', 'USAGE')");
  });

  it("the role holds exactly: USAGE on public and auth, column INSERT on documents and cost_documents, what the document rails read as the writer, and EXECUTE on its two policy predicates — no UPDATE, nothing on document_versions", () => {
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

  it.each([["intake_door_create_document", "documents", "true"], ["intake_door_file_quote", "cost_documents", "false"]])(
    "%s switches to intake_door for its one INSERT (no RETURNING; the id chosen first) and back before anything else runs", (name, table, newDoc) => {
      const body = fn(name);
      expect(body).toContain("v_id   uuid  := gen_random_uuid();");
      expect(body).toContain(`v_rls  boolean := intake_door_rls_ready(${newDoc});`);
      expect(body).toContain("v_role text  := current_setting('role');");
      const insert = between(body, `INSERT INTO ${table} (`, ");\n");
      expect(insert).not.toMatch(/RETURNING/);
      expect(insert).toMatch(/VALUES \(v_id, /);
      expect(body).toContain(`IF v_rls THEN PERFORM set_config('role', 'intake_door', true); END IF;\n  INSERT INTO ${table} (`);
      expect(body).toContain(`${insert}  IF v_rls THEN PERFORM set_config('role', v_role, true); END IF;\n  PERFORM intake_door_unbind(v_prev);\n  RETURN v_id;`);
      // the identity is bound before the switch
      expect(body.indexOf("v_prev := intake_door_bind(v_link, v_link, v_org, v_proj);")).toBeLessThan(body.indexOf("set_config('role', 'intake_door', true)"));
      expect(body.match(/set_config\('role'/g)).toHaveLength(2);
    });

  it("no other function switches role (the submission, pointer, promote and redline stay SECURITY DEFINER, where Postgres forbids it)", () => {
    for (const name of DOOR.filter((d) => !(RLS_DOOR as readonly string[]).includes(d))) {
      expect(fn(name), name).not.toMatch(/set_config\('role'/);
    }
    expect(C.match(/set_config\('role', 'intake_door', true\)/g)).toHaveLength(2);
  });

  it("intake_door_rls_ready: the role exists, this session's login may SET it (MEMBER before PG16), and for a new document intake_door may resolve auth.uid()", () => {
    const r = fn("intake_door_rls_ready");
    expect(r).toContain("WHEN to_regrole('intake_door') IS NULL THEN false");
    expect(r).toContain("WHEN NOT pg_has_role(session_user, 'intake_door',");
    expect(r).toContain("CASE WHEN current_setting('server_version_num')::int >= 160000 THEN 'SET' ELSE 'MEMBER' END) THEN false");
    expect(r).toContain("WHEN NOT p_new_document THEN true");
    expect(r).toContain("ELSE has_schema_privilege('intake_door', 'auth', 'USAGE')");
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
