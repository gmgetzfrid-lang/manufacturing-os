// projects Round G — J20 INTAKE DOOR UNDER RLS: the shape of 20261214
// (projects-tab SEC-22, GAP-401's remaining limbs).
//
//   (a) the submission (intake_door_submit_version) is re-created from its
//       NEWEST body (20261184, found by scanning) with the role switch around
//       its one INSERT; two policies TO intake_door on document_versions; the
//       insert-integrity policy re-created from its NEWEST body (20261205)
//       with ONE door limb; the readiness pair (gaps / ready).
//   (b) the door's housekeeping and intake folder as definer door functions
//       binding the link's identity; the route calls them first and keeps
//       today's writes when they are not there, on a state of their own.
//   (c) the rail on projects.intake_library_id / intake_collection_id.
//
// The SQL ran on a throwaway PostgreSQL 16 carrying schema.sql and the whole
// sequence (the records name the scenarios, A1–A15, B1–B14, C1–C9); this file
// pins the text the scratch run exercised.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const migDir = join(root, "supabase", "migrations");
const FILE = "20261214_prj_roundG_intake_door_rls.sql";
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
const prose = (text: string) => text.split("\n").map((l) => l.replace(/^--\s?/, "")).join(" ").replace(/\s+/g, " ");

const SIG: Record<string, string> = {
  intake_door_may_submit: "uuid, uuid, text, text, text, uuid, timestamptz, uuid, uuid",
  intake_door_version_rls_gaps: "name",
  intake_door_version_rls_ready: "",
  intake_door_submit_version: "text, jsonb",
  intake_door_housekeep: "text, text, uuid, uuid, timestamptz",
  intake_door_intake_folder: "text",
};

describe("the one-paste protocol (DEC-30)", () => {
  it("refuses to run without 20261184 and 20261205, then a TEMP inventory of COUNTs BEFORE the one transaction, and ONE final SELECT (check, ok, n)", () => {
    const pre = M.indexOf("DO $$");
    const inv = between(M, "CREATE TEMP TABLE prj_g_j20_inventory AS", "\nBEGIN;");
    expect(pre).toBeGreaterThan(0);
    expect(pre).toBeLessThan(M.indexOf("CREATE TEMP TABLE prj_g_j20_inventory"));
    expect(between(M, "DO $$", "$$;")).toContain("to_regprocedure('public.intake_door_submit_version(text, jsonb)') IS NULL");
    expect(between(M, "DO $$", "$$;")).toContain("to_regprocedure('public.document_has_versions(uuid)') IS NULL");
    expect(M.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(M.match(/^COMMIT;$/gm)).toHaveLength(1);
    for (const sel of inv.split(/UNION ALL/)) expect(sel, sel).toMatch(/COUNT\(\*\)::text/);
    const tail = M.slice(M.indexOf("\nCOMMIT;") + "\nCOMMIT;".length);
    // one statement after COMMIT: no other statement starts at a line's head, and it ends with the inventory rows
    expect(code(tail).split("\n").filter((l) => /^(BEGIN|COMMIT|CREATE|ALTER|GRANT|REVOKE|DROP|INSERT|UPDATE|DELETE|DO|SET)\b/.test(l))).toEqual([]);
    expect(code(tail).trim().endsWith("SELECT inventory, NULL::boolean, n FROM prj_g_j20_inventory;")).toBe(true);
    expect(code(tail).match(/^SELECT /gm)).toHaveLength(code(tail).match(/^UNION ALL$/gm)!.length + 1);
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,\s*\n\s*NULL::text AS n/);
    expect(tail).toContain("SELECT inventory, NULL::boolean, n FROM prj_g_j20_inventory;");
    // counts only — the inventory never selects a customer column
    expect(inv).not.toMatch(/SELECT\s+(name|title|document_number|company_name|contact_email)\b/i);
  });
  it("is the package's reserved number, and the sequence holds no other 20261214", () => {
    expect(numbered().filter((f) => f.startsWith("20261214"))).toEqual([FILE]);
  });
  it("the header names the three limbs, what stays off row-level security and why, the paste order (after 20261184 and 20261205), the re-paste warning and the deploy order", () => {
    const head = prose(M.slice(0, M.indexOf("-- ── Prerequisite")));
    for (const s of ["LIMB (a) — THE SUBMISSION UNDER ROW-LEVEL SECURITY", "LIMB (b) — THE DOOR'S HOUSEKEEPING UNDER THE BOUND IDENTITY",
      "LIMB (c) — THE INTAKE POINTERS' RAIL", "the pending pointer", "publish_revision is SECURITY DEFINER by design",
      "the ticket rails' service-only append", "PASTE ORDER: after 20261184", "and 20261205", "Never re-paste 20261205 after this file",
      "DEPLOY ORDER: none required."]) {
      expect(head, s).toContain(s);
    }
  });
});

describe("limb (a) — the submission re-created from its NEWEST body, with the role switch", () => {
  const newestEarlier = () => {
    const files = numbered().filter((f) => f < FILE && /CREATE OR REPLACE FUNCTION public\.intake_door_submit_version\(/.test(code(mig(f))));
    return files[files.length - 1];
  };
  it("the newest earlier definition is found by scanning the sequence (today 20261184)", () => {
    expect(newestEarlier()).toBe("20261184_prj_roundG_intake_door_identity.sql");
  });
  it("lineDiff: the only lines changed are DEFINER → INVOKER, the chosen id, the readiness / role locals, and the INSERT inside the switch loop (no RETURNING)", () => {
    const base = between(mig(newestEarlier()), "CREATE OR REPLACE FUNCTION public.intake_door_submit_version(", "\n$$;");
    const { onlyInA, onlyInB } = lineDiff(base, fn("intake_door_submit_version"));
    expect(onlyInA).toEqual([
      "SECURITY DEFINER",
      "  v_id   uuid;",
      "  INSERT INTO document_versions (org_id, record_id, revision_label, file_url, file_type, size, change_log,",
      "                                 created_by_name, created_at, released_at, review_state, provenance,",
      "                                 intake_link_id, file_hash, supersedes_version_id)",
      "  VALUES (v_org, v_v.record_id, v_v.revision_label, v_v.file_url, v_v.file_type, v_v.size, v_v.change_log,",
      "          v_v.created_by_name, COALESCE(v_v.created_at, NOW()), NULL, 'in_review', 'external',",
      "          v_link, v_v.file_hash, v_v.supersedes_version_id)",
      "  RETURNING id INTO v_id;",
    ]);
    const added = onlyInB.filter((l) => !/^\s*--/.test(l));
    expect(added).toEqual([
      "SECURITY INVOKER",
      "  v_id   uuid  := gen_random_uuid();",
      "  v_rls  boolean := intake_door_version_rls_ready();",
      "  v_role text  := current_setting('role');",
      "  LOOP",
      "    BEGIN",
      "      IF v_rls THEN PERFORM set_config('role', 'intake_door', true); END IF;",
      "      INSERT INTO document_versions (id, org_id, record_id, revision_label, file_url, file_type, size, change_log,",
      "                                     created_by_name, created_at, released_at, review_state, provenance,",
      "                                     intake_link_id, file_hash, supersedes_version_id)",
      "      VALUES (v_id, v_org, v_v.record_id, v_v.revision_label, v_v.file_url, v_v.file_type, v_v.size, v_v.change_log,",
      "              v_v.created_by_name, COALESCE(v_v.created_at, NOW()), NULL, 'in_review', 'external',",
      "              v_link, v_v.file_hash, v_v.supersedes_version_id);",
      "      IF v_rls THEN PERFORM set_config('role', v_role, true); END IF;",
      "      EXIT;",
      "    EXCEPTION WHEN insufficient_privilege THEN",
      "      IF v_rls THEN PERFORM set_config('role', v_role, true); END IF;",
      "      IF NOT v_rls",
      "         OR SQLERRM IN ('new row violates row-level security policy for table \"document_versions\"',",
      "                        'new row violates row-level security policy \"document_versions_intake_door_scope\" for table \"document_versions\"')",
      "         OR NOT (SQLERRM LIKE 'permission denied%' OR SQLERRM LIKE 'new row violates row-level security policy \"%') THEN",
      "        RAISE;",
      "      END IF;",
      "      RAISE WARNING 'intake_door_submit_version: % — this submission is written with the bound identity alone, without row-level security (projects-tab SEC-22).', SQLERRM;",
      "      v_rls := false;",
      "    END;",
      "  END LOOP;",
    ]);
  });
  it("the switch loop is intake_door_create_document's (20261184), statement for statement, with the table and its scope policy renamed", () => {
    const loop = (body: string) => between(body, "  LOOP\n", "  END LOOP;").split("\n").filter((l) => !/^\s*--/.test(l))
      .filter((l) => !/INSERT INTO|VALUES \(|^\s{6,}[a-z_, ]+\)?$|^\s+v_[a-z_.]+|^\s+created_by_name|^\s+intake_link_id/.test(l));
    const create = between(mig("20261184_prj_roundG_intake_door_identity.sql"), "CREATE OR REPLACE FUNCTION public.intake_door_create_document(", "\n$$;");
    const ours = loop(fn("intake_door_submit_version")).join("\n");
    const theirs = loop(create).join("\n").replace(/"documents"/g, "\"document_versions\"").replace(/documents_intake_door_scope/g, "document_versions_intake_door_scope")
      .replace("intake_door_create_document: % — this new document", "intake_door_submit_version: % — this submission");
    expect(ours).toBe(theirs);
  });
  it("the scope checks, the bind and the unbind are untouched; no other function of this file switches role", () => {
    const f = fn("intake_door_submit_version");
    expect(f).toContain("v_door jsonb := intake_door_resolve(p_token_hash);");
    expect(f).toContain("v_prev := intake_door_bind(v_link, v_link, v_org, v_proj);");
    expect(f).toContain("PERFORM intake_door_unbind(v_prev);");
    expect(code(f)).not.toMatch(/\bRETURNING\b/);
    expect(C.match(/set_config\('role', 'intake_door', true\)/g)).toHaveLength(1);
  });
});

describe("limb (a) — the policies TO intake_door and the integrity policy's door limb", () => {
  const newestEarlierPolicy = () => {
    const files = numbered().filter((f) => f < FILE && /CREATE POLICY document_versions_insert_integrity ON document_versions/.test(code(mig(f))));
    return files[files.length - 1];
  };
  const policy = (sql: string) => between(sql, "CREATE POLICY document_versions_insert_integrity ON document_versions", "\n);");
  it("the newest earlier definition of document_versions_insert_integrity is found by scanning (today 20261205)", () => {
    expect(newestEarlierPolicy()).toBe("20261205_dc_roundF_direct_write_issue_record.sql");
  });
  it("lineDiff: every line of 20261205's body is kept and the only lines added are the door limb; removing it gives the base back byte for byte", () => {
    const base = policy(mig(newestEarlierPolicy()));
    const ours = policy(M);
    const { onlyInA, onlyInB } = lineDiff(base, ours);
    expect(onlyInA).toEqual([]);
    expect(onlyInB).toEqual([
      "    CURRENT_USER = 'intake_door'",
      "    AND review_state = 'in_review' AND released_at IS NULL",
      "    AND provenance = 'external' AND intake_link_id IS NOT NULL AND created_by IS NULL",
    ]);
    const limb = "\n  OR (\n    CURRENT_USER = 'intake_door'\n    AND review_state = 'in_review' AND released_at IS NULL\n    AND provenance = 'external' AND intake_link_id IS NOT NULL AND created_by IS NULL\n  )";
    expect(ours.replace(limb, "")).toBe(base);
    // it stays RESTRICTIVE, for INSERT, written for every role (no TO clause)
    expect(ours).toMatch(/^CREATE POLICY document_versions_insert_integrity ON document_versions\nAS RESTRICTIVE FOR INSERT WITH CHECK \(/);
    expect(M).toContain("DROP POLICY IF EXISTS document_versions_insert_integrity ON document_versions;");
  });
  it("the limb adds no function to a policy every member's insert evaluates — no member needs EXECUTE on anything new", () => {
    const ours = policy(M);
    const base = policy(mig(newestEarlierPolicy()));
    const calls = (t: string) => [...t.matchAll(/\b([a-z_]+)\(/g)].map((m) => m[1]).filter((n) => !["CHECK", "WITH"].includes(n)).sort();
    expect(calls(ours)).toEqual(calls(base));
  });
  it("a permissive and a restrictive INSERT policy TO intake_door read intake_door_may_submit with the row's own columns; nothing else is granted on document_versions but column INSERT", () => {
    for (const [name, kind] of [["document_versions_intake_door_insert", "PERMISSIVE"], ["document_versions_intake_door_scope", "RESTRICTIVE"]]) {
      expect(C).toContain(`DROP POLICY IF EXISTS ${name} ON document_versions;\nCREATE POLICY ${name} ON document_versions\n  AS ${kind} FOR INSERT TO intake_door\n  WITH CHECK (intake_door_may_submit(org_id, record_id, file_url, review_state, provenance, intake_link_id, released_at, created_by, supersedes_version_id));`);
    }
    expect(C).not.toMatch(/GRANT\s+(SELECT|UPDATE|DELETE|ALL)[^;]*ON\s+(public\.)?document_versions/i);
    // the INSERT columns granted are exactly those the door's INSERT names
    const granted = between(M, "FOREACH c IN ARRAY ARRAY[", "] LOOP").replace("FOREACH c IN ARRAY ARRAY[", "").replace("] LOOP", "")
      .split(",").map((s) => s.trim().replace(/'/g, "")).filter(Boolean).sort();
    const inserted = between(fn("intake_door_submit_version"), "INSERT INTO document_versions (", ")\n").replace("INSERT INTO document_versions (", "").replace(")\n", "")
      .split(",").map((s) => s.trim()).filter(Boolean).sort();
    expect(granted).toEqual(inserted);
    expect(granted).not.toContain("created_by");
  });
  it("the predicate binds the row to the BOUND link: in review, external, unreleased, no member, its project's prefix, a document it authored or was assigned, a base of that document", () => {
    const p = fn("intake_door_may_submit");
    for (const s of ["v_door jsonb := intake_door_bound();", "AND v_door->>'purpose' IS DISTINCT FROM 'quote'", "AND p_org::text = v_door->>'org_id'",
      "AND p_link::text = v_door->>'link_id'", "AND p_review_state = 'in_review'", "AND p_provenance = 'external'", "AND p_released_at IS NULL",
      "AND p_created_by IS NULL", "'/project-intake/' || (v_door->>'project_id') || '/[^/]+$'", "d.authored_by_link_id = p_link",
      "jsonb_array_elements_text(v_door->'assigned')", "b.id = p_supersedes AND b.record_id = p_record"]) {
      expect(p, s).toContain(s);
    }
  });
  it("intake_door may EXECUTE, by name, what the live INSERT policies of document_versions call (document_has_versions is revoked from PUBLIC by 20261205)", () => {
    for (const f of ["user_can_publish_doc(uuid, uuid)", "doc_is_visible(uuid)", "document_has_versions(uuid)"]) {
      expect(C).toContain(`IF to_regprocedure('public.${f}') IS NOT NULL THEN\n    GRANT EXECUTE ON FUNCTION public.${f} TO intake_door;`);
    }
  });
  it("the readiness pair: intake_door_version_rls_gaps reads the live catalogs (switch, execute, read, policy) and excludes only the door's own scope policy and the integrity policy carrying the door limb; ready asks it for session_user", () => {
    const g = fn("intake_door_version_rls_gaps");
    expect(g).toMatch(/\nLANGUAGE plpgsql\nSTABLE\nSET search_path = public\nAS \$\$/);
    expect(g).toContain("v_table oid := to_regclass('public.document_versions');");
    expect(g).toContain("CASE WHEN current_setting('server_version_num')::int >= 160000 THEN 'SET' ELSE 'MEMBER' END");
    for (const s of ["'execute ' || f.fn::regprocedure::text", "'read ' || d.refobjid::regclass::text", "'policy ' || pol.polname::text",
      "AND NOT (pol.polname = 'document_versions_intake_door_scope' AND pol.polroles = ARRAY[v_door])",
      "AND pg_get_expr(pol.polwithcheck, pol.polrelid) LIKE '%CURRENT_USER = %intake_door%'"]) {
      expect(g, s).toContain(s);
    }
    expect(fn("intake_door_version_rls_ready")).toContain("SELECT cardinality(intake_door_version_rls_gaps(session_user)) = 0;");
    // the final SELECT asks the same function for authenticator, so the paste reports what the door will decide
    const tail = M.slice(M.indexOf("\nCOMMIT;"));
    expect(tail.match(/intake_door_version_rls_gaps\('authenticator'\)/g)?.length).toBe(2);
  });
});

describe("DRLS-16 — every function this migration adds or re-creates", () => {
  it("each function pins search_path; SECURITY DEFINER are exactly the predicate, the two housekeeping door functions and the rail; the submission, gaps and ready are INVOKER", () => {
    const heads = [...M.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\([^)]*\)[\s\S]*?AS \$\$/g)];
    expect(heads.map((m) => m[1])).toEqual(["intake_door_may_submit", "intake_door_version_rls_gaps", "intake_door_version_rls_ready",
      "intake_door_submit_version", "intake_door_housekeep", "intake_door_intake_folder", "enforce_project_intake_pointers"]);
    for (const h of heads) expect(h[0], h[1]).toMatch(/\nSET search_path = public\nAS \$\$/);
    expect(heads.filter((m) => /SECURITY DEFINER/.test(m[0])).map((m) => m[1])).toEqual(["intake_door_may_submit", "intake_door_housekeep",
      "intake_door_intake_folder", "enforce_project_intake_pointers"]);
  });
  it("grants: the predicate is intake_door's alone; the door functions and the readiness pair the service role's alone; the rail's function no client role's", () => {
    expect(C).toContain(`REVOKE ALL ON FUNCTION public.intake_door_may_submit(${SIG.intake_door_may_submit}) FROM PUBLIC, anon, authenticated, service_role;`);
    expect(C).toContain(`GRANT EXECUTE ON FUNCTION public.intake_door_may_submit(${SIG.intake_door_may_submit}) TO intake_door;`);
    for (const name of ["intake_door_version_rls_gaps", "intake_door_version_rls_ready", "intake_door_submit_version", "intake_door_housekeep", "intake_door_intake_folder"]) {
      expect(C).toContain(`REVOKE ALL ON FUNCTION public.${name}(${SIG[name]}) FROM PUBLIC, anon, authenticated;`);
      expect(C).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(${SIG[name]}) TO service_role;`);
    }
    for (const r of ["PUBLIC", "anon", "authenticated"]) expect(C).toContain(`REVOKE ALL ON FUNCTION public.enforce_project_intake_pointers() FROM ${r};`);
    expect(C).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.\w+\([^)]*\) TO [^;]*(anon|authenticated|PUBLIC)/);
  });
  it("the definer housekeeping refuses a signed-in caller inside (a NULL auth.uid() is trusted only because no client role may EXECUTE)", () => {
    expect(fn("intake_door_housekeep")).toMatch(/BEGIN\s*\n\s*IF auth\.uid\(\) IS NOT NULL THEN\s*\n\s*RAISE EXCEPTION 'intake_door: only the intake route, under the service key, opens the contractor door\.'\s*\n\s*USING ERRCODE = '42501';/);
    expect(fn("intake_door_intake_folder")).toContain("v_door jsonb := intake_door_resolve(p_token_hash);");
  });
  it("raises no 42883 and no message a door handler could read as 'not there' or as a privilege gap (the route's and 20261184's handlers decide by them)", () => {
    expect(M).not.toMatch(/ERRCODE\s*=\s*'42883'|undefined_function/);
    expect(C).not.toMatch(/RAISE EXCEPTION 'permission denied|RAISE EXCEPTION 'new row violates/);
    expect(C).not.toMatch(/RAISE EXCEPTION 'function /);
  });
  it("takes nothing away from intake_door: no REVOKE of a helper the door policies call, and no schema sweep", () => {
    expect(C).not.toMatch(/REVOKE[^;]*ON (FUNCTION|ROUTINE) [^;]*\b(my_org_ids|is_org_controller|acl_index_denies|user_owns_project|user_can_publish_doc|doc_is_visible|document_has_versions|uid)\s*\(/i);
    expect(C).not.toMatch(/ON ALL (FUNCTIONS|ROUTINES) IN SCHEMA/i);
  });
});

describe("limb (b) — the housekeeping as the link's identity", () => {
  it("intake_door_housekeep: 'retire' needs a live link (intake_door_resolve); the undo / record ops need the link to exist (a revocation never strands them); each op checks the row is the link's own, binds, writes, unbinds", () => {
    const h = fn("intake_door_housekeep");
    expect(h).toMatch(/IF p_op = 'retire' THEN\s*\n\s*-- [^\n]*\n\s*v_door := intake_door_resolve\(p_token_hash\);/);
    expect(h).toContain("ELSIF p_op IN ('restore', 'withdraw', 'discard', 'reference') THEN");
    expect(h).toContain("SELECT * INTO v_row FROM project_intake_links WHERE token_hash = p_token_hash;");
    expect(h).toContain("RAISE EXCEPTION 'intake_door_housekeep: unknown operation %.', p_op USING ERRCODE = '22023';");
    for (const s of [
      "v.intake_link_id = v_link",
      "COALESCE((v_door->>'trusted')::boolean, false) AND v_author IS NOT DISTINCT FROM v_link AND NOT v_assigned",
      "IF v_author IS DISTINCT FROM v_link OR v_current IS NOT NULL THEN",
      "WHERE id = p_version AND record_id = p_doc AND review_state = 'in_review' AND superseded_at IS NULL;",
      "WHERE id = p_version AND record_id = p_doc AND superseded_at = p_at;",
      "WHERE id = p_version AND record_id = p_doc AND review_state = 'superseded';",
      "DELETE FROM documents WHERE id = p_doc AND org_id = v_org AND authored_by_link_id = v_link AND current_version_id IS NULL;",
      "ON CONFLICT (project_id, document_id) DO NOTHING;",
      "v_prev := intake_door_bind(v_link, v_link, v_org, v_proj);",
    ]) expect(h, s).toContain(s);
    expect(h.match(/PERFORM intake_door_unbind\(v_prev\);/g)).toHaveLength(1);
  });
  it("intake_door_intake_folder: the project's folder when it is one of the intake library's in the link's org; else made there and claimed by compare-and-set; a lost race drops it and answers the winner", () => {
    const f = fn("intake_door_intake_folder");
    for (const s of [
      "RAISE EXCEPTION 'intake_door: the project''s intake library is not set.' USING ERRCODE = '42501', HINT = 'not_configured';",
      "EXISTS (SELECT 1 FROM collections c WHERE c.id = v_cur AND c.org_id = v_org AND c.library_id = v_lib)",
      "INSERT INTO collections (org_id, library_id, name)",
      "VALUES (v_org, v_lib, 'Intake — ' || COALESCE(v_name, 'Project'))",
      "WHERE id = v_proj AND org_id = v_org AND intake_collection_id IS NOT DISTINCT FROM v_cur;",
      "DELETE FROM collections WHERE id = v_new;",
    ]) expect(f, s).toContain(s);
    expect(f.match(/PERFORM intake_door_unbind\(v_prev\);/g)).toHaveLength(2);
    // the folder name is the route's own (ensureIntakeFolder): "Intake — <project>", "Project" when unnamed
    expect(ROUTE).toContain("name: `Intake — ${input.projectName}`");
    expect(ROUTE).toContain('projectName: String(project.name ?? "Project")');
  });
  it("the route calls each with the parameters the SQL declares, on a door state of its own, and keeps today's write only when the function is not there", () => {
    expect(ROUTE).toContain('supabaseAdmin.rpc("intake_door_housekeep", {\n        p_token_hash: door.tokenHash, p_op: op, p_doc: args.doc, p_version: args.version ?? null, p_at: args.at ?? null,');
    expect(ROUTE).toContain('supabaseAdmin.rpc("intake_door_intake_folder", { p_token_hash: input.door!.tokenHash })');
    const params = (name: string) => between(M, `CREATE OR REPLACE FUNCTION public.${name}(`, ")\nRETURNS").match(/\bp_\w+/g);
    expect(params("intake_door_housekeep")).toEqual(["p_token_hash", "p_op", "p_doc", "p_version", "p_at"]);
    expect(params("intake_door_intake_folder")).toEqual(["p_token_hash"]);
    expect(ROUTE).toContain("const housekeeping: DoorHousekeeping = { state: { absent: false }, tokenHash };");
    // the ops the route sends are exactly those the SQL accepts
    const routeOps = between(ROUTE, 'type HousekeepOp = ', ";").match(/"(\w+)"/g)!.map((s) => s.replace(/"/g, "")).sort();
    expect(routeOps).toEqual(["discard", "reference", "restore", "retire", "withdraw"]);
    // every call site keeps today's service-role write ONLY on "absent" — never after the door answered
    for (const site of ["const viaDb = await housekeepVia(housekeeping, \"discard\"", "const viaDb = await housekeepVia(housekeeping, \"withdraw\"",
      "const viaDb = await housekeepVia(housekeeping, \"reference\""]) {
      const block = between(ROUTE, site, "console.error(");
      expect(block, site).toMatch(/else if \(viaDb\.kind === "absent"\)/);
    }
    expect(between(ROUTE, "async function retireDisplacedFirst(", "const attempt = async")).toContain('if (viaDb.kind === "error") return {');
    expect(between(ROUTE, "async function restoreDisplaced(", "console.error(")).toMatch(/if \(viaDb\.kind === "ok"\) return;\s*\n\s*if \(viaDb\.kind === "error"\) \{/);
  });
});

describe("limb (c) — the rail on the intake pointers", () => {
  const r = () => fn("enforce_project_intake_pointers");
  it("bound to projects BEFORE INSERT OR UPDATE OF the two pointers, per row", () => {
    expect(C).toContain("DROP TRIGGER IF EXISTS trg_projects_intake_pointers ON projects;\nCREATE TRIGGER trg_projects_intake_pointers\n  BEFORE INSERT OR UPDATE OF intake_library_id, intake_collection_id ON projects\n  FOR EACH ROW\n  EXECUTE FUNCTION public.enforce_project_intake_pointers();");
  });
  it("the order: the service pass, the door's own folder repair (its project's link, the library unchanged, a folder of it, from none or a stale one), the library of the workspace, no move under live links but by a controller, the folder of the library (cleared when the library moved away from it)", () => {
    const b = r();
    const at = (s: string) => { const i = b.indexOf(s); expect(i, s).toBeGreaterThan(0); return i; };
    const order = [
      at("IF auth.uid() IS NULL THEN RETURN NEW; END IF;"),
      at("IF COALESCE(v_claims->>'role', '') = 'intake_door' THEN"),
      at("AND NOT EXISTS (SELECT 1 FROM libraries l WHERE l.id = NEW.intake_library_id AND l.org_id = NEW.org_id) THEN"),
      at("AND NOT is_org_controller(NEW.org_id)"),
      at("NEW.intake_collection_id := NULL;"),
    ];
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    for (const s of [
      "AND v_claims->>'intake_link_id' = auth.uid()::text",
      "EXISTS (SELECT 1 FROM project_intake_links l WHERE l.id = auth.uid() AND l.project_id = NEW.id AND l.org_id = NEW.org_id)",
      "AND NEW.intake_library_id IS NOT DISTINCT FROM v_old_lib",
      "WHERE l.project_id = NEW.id AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > NOW())",
      "AND COALESCE(l.purpose, 'documents') <> 'quote') THEN",
    ]) expect(b, s).toContain(s);
    // refusals are 42501 with a sentence a person can act on
    expect(b.match(/USING ERRCODE = 'insufficient_privilege'/g)).toHaveLength(4);
    expect(b).toContain("only an Admin or Document Control can change where they file (the project''s intake library and folder) — revoke the links first, or ask one of them; nothing was changed.");
  });
  it("regression: the Intake tab writes the library only while it is unset — a first set the rail never refuses for a library of the workspace", () => {
    const panel = readFileSync(join(root, "components/projects/IntakePanel.tsx"), "utf8");
    expect(panel).toContain('if (!intakeLibraryId) {\n        const { error: libErr } = await supabase.from("projects").update({ intake_library_id: lib }).eq("id", projectId);');
    // the move limb needs a SET pointer (v_old_lib IS NOT NULL)
    expect(r()).toContain("AND ((v_old_lib IS NOT NULL AND NEW.intake_library_id IS DISTINCT FROM v_old_lib)");
  });
});
