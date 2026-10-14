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
// sequence (the records name the scenarios, A1–A23, B1–B17, C1–C9); this file
// pins the text the scratch run exercised. It also carries the forward scan
// for document_versions that J16's census (documents, cost_documents) leaves
// to this file: a later migration may not take the submission off row-level
// security unannounced.

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
  it("review fix pass (major): the door's own permissive policy missing is a gap — readiness reads false and the submission keeps the bound identity, filed (dropping the door's policies is a safe reversal, never a refused upload)", () => {
    const g = fn("intake_door_version_rls_gaps");
    expect(g).toContain("IF NOT EXISTS (SELECT 1 FROM pg_policy pol\n                  WHERE pol.polrelid = v_table AND pol.polpermissive AND pol.polcmd IN ('a', '*')\n                    AND v_door = ANY (pol.polroles)) THEN\n    v_gaps := v_gaps || 'no permissive policy for intake_door'::text;\n  END IF;\n");
    // read from the catalogs, after every other limb, so ready() (cardinality = 0) sees it
    expect(g.indexOf("'no permissive policy for intake_door'")).toBeGreaterThan(g.indexOf("SELECT DISTINCT 'policy '"));
    // the unnamed refusal it prevents is the one the switch re-raises (the door's own boundary)
    expect(fn("intake_door_submit_version")).toContain("'new row violates row-level security policy for table \"document_versions\"'");
    // the two "row-level security for the submission" rows together read every gap class: the first now names this one
    const tail = M.slice(M.indexOf("\nCOMMIT;"));
    const row = between(tail, "SELECT 'row-level security for the submission: authenticator", "       NULL\nUNION ALL");
    expect(row).toContain("the door''s permissive policy is there");
    expect(row).toMatch(/WHERE g IN \('role', 'switch', 'no permissive policy for intake_door'(, '[a-z_ ]+')*\) OR g LIKE 'execute %' OR g LIKE 'read %'\),/);
    expect(M).toContain("''no permissive policy for intake_door'' when no PERMISSIVE INSERT / ALL policy of it names intake_door");
    expect(prose(M.slice(0, M.indexOf("-- ── Prerequisite")))).toContain("and the door's own permissive policy missing (no row would be admitted as intake_door; Postgres would refuse it naming none).");
  });
});

describe("review fix pass 2 (major) — a column default on document_versions.created_by is a readiness gap, read from the live catalogs", () => {
  const g = () => fn("intake_door_version_rls_gaps");
  const tail = () => M.slice(M.indexOf("\nCOMMIT;"));
  it("intake_door_version_rls_gaps reports 'default created_by' when pg_attrdef holds a default (or generation expression) for the column — the last check before RETURN, so ready() (cardinality = 0) reads false", () => {
    expect(g()).toContain("  IF EXISTS (SELECT 1 FROM pg_attribute a\n               JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum\n              WHERE a.attrelid = v_table AND a.attname = 'created_by' AND NOT a.attisdropped) THEN\n    v_gaps := v_gaps || 'default created_by'::text;\n  END IF;\n  RETURN v_gaps;\nEND;");
    expect(g().indexOf("'default created_by'")).toBeGreaterThan(g().indexOf("'no permissive policy for intake_door'"));
    expect(M).toContain("''default created_by'' when document_versions.created_by carries a column default");
  });
  it("why it matters, pinned on the text it protects: the door's INSERT leaves created_by out (so a live default fills it) while both door policies and the integrity limb require it NULL", () => {
    const insert = between(fn("intake_door_submit_version"), "INSERT INTO document_versions (", ")\n");
    expect(insert).not.toMatch(/\bcreated_by\b(?!_name)/);
    expect(fn("intake_door_may_submit")).toContain("AND p_created_by IS NULL");
    for (const name of ["document_versions_intake_door_insert", "document_versions_intake_door_scope"]) {
      expect(between(C, `CREATE POLICY ${name} ON document_versions`, ";")).toContain("released_at, created_by, supersedes_version_id)");
    }
    expect(between(C, "CREATE POLICY document_versions_insert_integrity ON document_versions", ");\n")).toContain("provenance = 'external' AND intake_link_id IS NOT NULL AND created_by IS NULL");
    // the switch re-raises the unnamed refusal such a default would cause — the gap is what keeps it from happening
    expect(fn("intake_door_submit_version")).toContain("'new row violates row-level security policy for table \"document_versions\"'");
  });
  it("the paste reads it: the first 'row-level security for the submission' row names the gap, and an inventory row counts the live default", () => {
    const row = between(tail(), "SELECT 'row-level security for the submission: authenticator", "       NULL\nUNION ALL");
    expect(row).toContain("and document_versions.created_by has no column default — false: each submission keeps the bound identity alone, filed as before (SEC-22)");
    expect(row).toContain("WHERE g IN ('role', 'switch', 'no permissive policy for intake_door', 'default created_by') OR g LIKE 'execute %' OR g LIKE 'read %'),");
    const inv = between(M, "CREATE TEMP TABLE prj_g_j20_inventory AS", "\nBEGIN;");
    expect(inv).toContain("SELECT 'inventory: column defaults on document_versions.created_by (the door''s INSERT leaves the column out; 1 = the live table fills it, so each submission keeps the bound identity, filed, and the first \"row-level security for the submission\" row reads false)',\n       COUNT(*)::text\n  FROM pg_attribute a\n  JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum\n WHERE a.attrelid = 'public.document_versions'::regclass AND a.attname = 'created_by' AND NOT a.attisdropped\n");
    // the shape the integrator pastes: 10 probes, then the one SELECT of the 7 inventory rows
    const selects = tail().match(/^UNION ALL$/gm)!.length + 1;
    expect(selects - 1).toBe(10);
    expect(inv.split(/\nUNION ALL\n/)).toHaveLength(7);
    expect(prose(M.slice(0, M.indexOf("-- ── Prerequisite")))).toContain("A column default on document_versions.created_by is a gap too:");
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
      "IF p_op = 'retire' AND NOT (v_author IS NOT DISTINCT FROM v_link OR v_assigned) THEN",
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
  it("review fix pass: 'restore' and 'withdraw' need only the version to be the link's own submission on the document (an un-assignment mid-request never strands this request's rows); only 'retire' needs the document still the link's own or assigned", () => {
    const h = fn("intake_door_housekeep");
    const scope = between(h, "  IF p_op IN ('retire', 'restore', 'withdraw') THEN\n", "  ELSIF p_op = 'discard' THEN");
    const code_ = scope.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
    // the shared check: the version, this link's, on this document, in the link's org — nothing about the document's author or assignment
    const shared = between(code_, "    IF p_version IS NULL", "    END IF;");
    expect(shared).toContain("WHERE v.id = p_version AND v.record_id = p_doc AND v.org_id = v_org AND v.intake_link_id = v_link) THEN");
    expect(shared).not.toMatch(/v_author|v_assigned/);
    // every use of the author or the assignment in this block is behind p_op = 'retire'
    for (const l of code_.split("\n").filter((x) => /v_author|v_assigned/.test(x))) {
      const at = code_.indexOf(l);
      const head = code_.lastIndexOf("    IF ", at);
      expect(code_.slice(head, at + l.length), l).toMatch(/^    IF p_op = 'retire'/);
    }
    // 'discard' and 'reference' still need the document to be the link's creation (authored_by_link_id never changes — INTK-16)
    expect(h).toContain("IF v_author IS DISTINCT FROM v_link OR v_current IS NOT NULL THEN");
    expect(h).toContain("IF v_author IS DISTINCT FROM v_link THEN");
    const head = prose(M.slice(0, M.indexOf("-- ── Prerequisite")));
    expect(head).toContain("'restore' and 'withdraw' need only the version to be the link's own submission on the document (not the document still assigned to the link), so an un-assignment mid-request never strands them either");
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

// ── Review fix pass (minor): the forward scan for document_versions ─────────
// J16's census covers documents and cost_documents. A later migration that
// adds a RESTRICTIVE INSERT / ALL policy on document_versions for every role
// (or intake_door) without saying how intake_door is treated, re-creates
// document_versions_insert_integrity without the door limb (from 20261205's
// body, say), or drops the door's own policies without re-creating them,
// would quietly take the submission off row-level security (fail-safe: it
// falls back to the bound identity, filed) — this test announces it.
const DV = String.raw`(?:public\.)?"?document_versions"?`;
const CREATE_ON_DV = new RegExp(String.raw`\bCREATE POLICY "?(\w+)"? ON ${DV} (.*)$`, "i");
const ALTER_ON_DV = new RegExp(String.raw`\bALTER POLICY "?(\w+)"? ON ${DV} (.*)$`, "i");
const POLICY_TAIL = /^(?:AS (PERMISSIVE|RESTRICTIVE)\s*)?(?:FOR (ALL|SELECT|INSERT|UPDATE|DELETE)\s*)?(?:TO ((?:(?!\bUSING\b|\bWITH CHECK\b).)+?)\s*)?((?:USING|WITH CHECK)\b.*)?$/i;
const ALTER_TAIL = /^(?:TO ((?:(?!\bUSING\b|\bWITH CHECK\b).)+?)\s*)?((?:USING|WITH CHECK)\b.*)?$/i;
const appliesToDoor = (to: string | undefined) => !to
  || to.split(",").map((r) => r.trim().replace(/"/g, "").toLowerCase()).some((r) => r === "public" || r === "intake_door");
const statements = (sql: string) => code(sql).split(";").map((x) => x.replace(/\s+/g, " ").trim());
/** The restrictive INSERT / ALL policies on document_versions that schema.sql and every migration create (read once). */
let restrictiveKnown: Set<string> | null = null;
function restrictiveVersionPolicies(): Set<string> {
  if (restrictiveKnown) return restrictiveKnown;
  const out = new Set<string>();
  for (const sql of [readFileSync(join(root, "supabase", "schema.sql"), "utf8"), ...numbered().map(mig)]) {
    for (const st of statements(sql)) {
      const c = /POLICY/i.test(st) ? st.match(CREATE_ON_DV) : null;
      const t = c?.[2].match(POLICY_TAIL);
      if (c && t && /RESTRICTIVE/i.test(t[1] ?? "") && /^(ALL|INSERT)$/i.test(t[2] ?? "ALL")) out.add(c[1]);
    }
  }
  restrictiveKnown = out;
  return out;
}
/** What a migration adds that may refuse the door's submission as intake_door, unless the file says how intake_door is
 *  treated (a predicate naming it, or a comment `-- intake_door: <policy> …`): a RESTRICTIVE policy FOR INSERT or ALL
 *  (or no FOR) on document_versions with no TO clause or one naming PUBLIC or intake_door — made directly, in a DO
 *  block, or by format() in a file naming the table — or an ALTER POLICY re-writing one already restrictive. */
function restrictsSubmission(sql: string, known: ReadonlySet<string> = restrictiveVersionPolicies()): string[] {
  const stated = (name: string) => new RegExp(String.raw`--\s*intake_door:\s*"?${name}"?\b`, "i").test(sql);
  const out: string[] = [];
  const namesTable = /'(?:public\.)?document_versions'/i.test(code(sql));
  for (const st of statements(sql)) {
    if (!/POLICY/i.test(st)) continue;
    const c = st.match(CREATE_ON_DV);
    if (c) {
      const t = c[2].match(POLICY_TAIL);
      const [kind, cmd, to, predicate] = t ? [t[1], t[2], t[3], t[4] ?? ""] : ["RESTRICTIVE", undefined, undefined, c[2]];
      if (!/RESTRICTIVE/i.test(kind ?? "") || !/^(ALL|INSERT)$/i.test(cmd ?? "ALL") || !appliesToDoor(to)) continue;
      if (/\bintake_door/i.test(predicate) || stated(c[1])) continue;
      out.push(`${c[1]}: ${st.slice(0, 140)}`);
      continue;
    }
    const a = st.match(ALTER_ON_DV);
    if (a) {
      if (!known.has(a[1]) || /^RENAME\b/i.test(a[2])) continue;
      const t = a[2].match(ALTER_TAIL);
      const [to, predicate] = t ? [t[1], t[2] ?? ""] : [undefined, a[2]];
      if (!appliesToDoor(to) || /\bintake_door/i.test(predicate) || stated(a[1])) continue;
      out.push(`${a[1]} (altered): ${st.slice(0, 140)}`);
      continue;
    }
    const f = st.match(/\bCREATE POLICY %I\w* ON %I (.*)$/i);
    if (f && namesTable && !/--\s*intake_door:/i.test(sql)) {
      const t = f[1].match(POLICY_TAIL);
      if (t && /RESTRICTIVE/i.test(t[1] ?? "") && /^(ALL|INSERT)$/i.test(t[2] ?? "ALL") && appliesToDoor(t[3])) out.push(`format(): ${st.slice(0, 140)}`);
    }
  }
  return out;
}
/** Every statement of the sequence (schema.sql, then the numbered files in order) that defines, re-writes or drops a policy. */
function policyHistory(name: string): Array<{ file: string; st: string }> {
  const files: Array<[string, string]> = [["schema.sql", readFileSync(join(root, "supabase", "schema.sql"), "utf8")], ...numbered().map((f) => [f, mig(f)] as [string, string])];
  const re = new RegExp(String.raw`\b(CREATE|ALTER|DROP) POLICY (IF EXISTS )?"?${name}"? ON ${DV}\b`, "i");
  return files.flatMap(([file, sql]) => statements(sql).filter((st) => re.test(st)).map((st) => ({ file, st })));
}

describe("review fix pass — no later migration takes the door's submission off row-level security unannounced (document_versions, J16's census extended)", () => {
  it("no migration after 20261214 adds or re-writes a restrictive INSERT / ALL policy on document_versions that applies to intake_door without saying how intake_door is treated", () => {
    for (const f of numbered().filter((x) => x > FILE)) expect(restrictsSubmission(mig(f)), f).toEqual([]);
  });
  it("the newest definition of document_versions_insert_integrity still carries the door limb (CURRENT_USER = 'intake_door'); a re-paste of 20261205's body after this file would fail here", () => {
    const hist = policyHistory("document_versions_insert_integrity").filter((h) => !/^DROP\b/i.test(h.st));
    const newest = hist[hist.length - 1];
    expect(newest.file >= FILE, newest.file).toBe(true);
    expect(newest.st).toMatch(/CURRENT_USER = 'intake_door' AND review_state = 'in_review' AND released_at IS NULL AND provenance = 'external' AND intake_link_id IS NOT NULL AND created_by IS NULL/);
    // and it is not dropped after its newest definition
    const last = policyHistory("document_versions_insert_integrity").slice(-1)[0];
    expect(/^DROP\b/i.test(last.st), last.file).toBe(false);
  });
  it("the door's own two policies are last CREATED (never left dropped) by the newest migration that touches them, each still TO intake_door reading intake_door_may_submit", () => {
    for (const name of ["document_versions_intake_door_insert", "document_versions_intake_door_scope"]) {
      const hist = policyHistory(name);
      const last = hist[hist.length - 1];
      expect(last.st, `${name} in ${last.file}`).toMatch(new RegExp(String.raw`^CREATE POLICY ${name} ON document_versions AS (PERMISSIVE|RESTRICTIVE) FOR INSERT TO intake_door WITH CHECK \(intake_door_may_submit\(`));
    }
  });
  it("its exclusions are what the sequence holds: up to 20261214 the restrictive INSERT / ALL policy for every role on document_versions without a door clause is 20261205's insert-integrity body, and this file's re-creation passes", () => {
    const upTo = [readFileSync(join(root, "supabase", "schema.sql"), "utf8"), ...numbered().filter((f) => f < FILE).map(mig)];
    const found = new Set(upTo.flatMap((sql) => restrictsSubmission(sql)).map((x) => x.slice(0, x.indexOf(":"))));
    expect([...found].every((n) => n === "document_versions_insert_integrity"), [...found].join(", ")).toBe(true);
    expect(found.has("document_versions_insert_integrity")).toBe(true);
    expect(restrictsSubmission(M)).toEqual([]);
  });
  it("the detector: a membership-shaped restrictive policy is caught, as are ALL / no FOR, TO public / intake_door, one in a DO block, a format() one, 20261205's integrity body and an ALTER of it; a TO clause leaving intake_door out, a predicate or a comment naming it, a permissive or an UPDATE policy, or another table are not", () => {
    const hardening = "CREATE POLICY dv_member_insert ON document_versions AS RESTRICTIVE FOR INSERT WITH CHECK (org_id IN (SELECT my_org_ids()));";
    expect(restrictsSubmission(hardening)).toHaveLength(1);
    expect(restrictsSubmission(hardening.replace("FOR INSERT", "FOR ALL"))).toHaveLength(1);
    expect(restrictsSubmission(hardening.replace(" FOR INSERT", ""))).toHaveLength(1);
    expect(restrictsSubmission(hardening.replace("FOR INSERT", "FOR INSERT TO public"))).toHaveLength(1);
    expect(restrictsSubmission(hardening.replace("FOR INSERT", "FOR INSERT TO authenticated, intake_door"))).toHaveLength(1);
    expect(restrictsSubmission(hardening.replace("ON document_versions", "ON public.document_versions"))).toHaveLength(1);
    expect(restrictsSubmission(`DO $$\nBEGIN\n  ${hardening}\nEND $$;`)).toHaveLength(1);
    expect(restrictsSubmission("DO $$ DECLARE t text := 'document_versions'; BEGIN\n  EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR INSERT WITH CHECK (%s)', t || '_x', t, 'is_org_controller(org_id)');\nEND $$;")).toHaveLength(1);
    const p23 = between(mig("20261205_dc_roundF_direct_write_issue_record.sql"), "CREATE POLICY document_versions_insert_integrity ON document_versions", "\n);");
    expect(restrictsSubmission(`${p23};`)).toHaveLength(1);
    expect(restrictsSubmission("ALTER POLICY document_versions_insert_integrity ON document_versions WITH CHECK (user_can_publish_doc(record_id, org_id));")).toHaveLength(1);
    // not caught
    expect(restrictsSubmission(hardening.replace("FOR INSERT", "FOR INSERT TO authenticated"))).toEqual([]);
    expect(restrictsSubmission(hardening.replace("(org_id IN", "(CURRENT_USER = 'intake_door' OR org_id IN"))).toEqual([]);
    expect(restrictsSubmission(`-- intake_door: dv_member_insert — the door's submission is admitted by its own scope policy\n${hardening}`)).toEqual([]);
    expect(restrictsSubmission(hardening.replace("AS RESTRICTIVE ", ""))).toEqual([]);
    expect(restrictsSubmission(hardening.replace("FOR INSERT WITH CHECK", "FOR UPDATE USING"))).toEqual([]);
    expect(restrictsSubmission(hardening.replace("ON document_versions", "ON documents"))).toEqual([]);
    expect(restrictsSubmission("ALTER POLICY document_versions_org_access ON document_versions USING (org_id IN (SELECT my_org_ids()));")).toEqual([]);
    expect(restrictsSubmission("ALTER POLICY document_versions_insert_integrity ON document_versions RENAME TO document_versions_integrity;")).toEqual([]);
  });
});
