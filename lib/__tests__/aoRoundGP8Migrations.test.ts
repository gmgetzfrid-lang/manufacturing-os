// admin-and-org Round G, P8 ORG-ADMIN SURFACES — shape pins on its two
// migrations.
//
//   20261203  ORG-13 team_members org rail (trigger + audited removal of the
//             rows that already break it), node_visible's team lookup
//             org-scoped (re-created from its NEWEST definition, one line),
//             ORG-6's acl_subject_in_bucket pin, and the workspace time-zone
//             key made an Admin's (the three per-key RESTRICTIVE policies,
//             re-created from their NEWEST definition, one line each).
//   20261204  revoke_member re-created from its NEWEST definition (found by
//             scanning — 20261161 today, which carries the NEDGE-7 tombstone)
//             with ALOG-15's updated_at stamp and ORG-7's ACL prune, the pure
//             helpers, the stale-grant backfill, and ALOG-3's library-delete
//             audit trigger.
//
// Every "newest earlier definition" is found by scanning supabase/migrations
// at test time, so a parallel re-creation folded in at a merge is diffed
// against, never skipped.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildAclIndexFromChain } from "@/lib/acl";
import type { AccessControl, AccessRule, AclIndex } from "@/types/schema";

const DIR = join(process.cwd(), "supabase", "migrations");
const FILES = readdirSync(DIR).filter((f) => /^\d{8}_.*\.sql$/.test(f)).sort();
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const A_FILE = "20261203_ao_roundG_team_members_org_rail.sql";
const B_FILE = "20261204_ao_roundG_revoke_member_acl_prune.sql";
const A = read(A_FILE);
const B = read(B_FILE);
// fix pass 3 (ALOG-4): the removal row's rolesBefore line, exactly
const ROLES_BEFORE = "                             'rolesBefore', to_jsonb(CASE WHEN v_member.role IS NULL OR v_member.role = ANY(COALESCE(v_member.roles, '{}'::text[])) THEN COALESCE(v_member.roles, '{}'::text[]) ELSE array_append(COALESCE(v_member.roles, '{}'::text[]), v_member.role) END), 'rolesAfter', '[]'::jsonb,";

function lineDiff(a: string, b: string) {
  const AL = a.split("\n"), BL = b.split("\n");
  return { onlyInA: AL.filter((l) => !BL.includes(l)), onlyInB: BL.filter((l) => !AL.includes(l)) };
}

/** Every CREATE [OR REPLACE] FUNCTION <name>( … in the given files, in order,
 *  with the body up to its closing dollar quote. `arity` filters on the
 *  number of top-level parameters. */
function definitions(name: string, files: string[], arity?: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${name}\\s*\\(`, "g");
  for (const f of files) {
    const s = read(f);
    for (const m of s.matchAll(re)) {
      const lineStart = s.lastIndexOf("\n", m.index!) + 1;
      if (/^\s*--/.test(s.slice(lineStart, m.index!))) continue;
      const open = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/g;
      open.lastIndex = m.index!;
      const tag = open.exec(s)!;
      const end = s.indexOf(tag[0], tag.index + tag[0].length);
      const text = s.slice(m.index!, end + tag[0].length + 1);
      if (arity !== undefined) {
        const params = s.slice(m.index! + m[0].length, s.indexOf(")", m.index! + m[0].length));
        const n = params.trim() === "" ? 0 : params.split(",").length;
        if (n !== arity) continue;
      }
      out.push([f, text]);
    }
  }
  return out;
}

/** The policy block (DROP … CREATE … ;) for one policy name, in a file. */
function policyBlock(text: string, name: string): string {
  const a = text.indexOf(`CREATE POLICY ${name} ON org_configurations`);
  expect(a, name).toBeGreaterThanOrEqual(0);
  return text.slice(a, text.indexOf(";", a) + 1);
}

const before = (f: string) => FILES.filter((x) => x < f);

// ── DEC-30 shape, both files ────────────────────────────────────────────────
describe("DEC-30 one-paste shape", () => {
  for (const [name, text] of [[A_FILE, A], [B_FILE, B]] as const) {
    it(`${name}: counts-only TEMP inventory BEFORE the transaction, one BEGIN / COMMIT, one final (check, ok, n) SELECT`, () => {
      const code = text.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
      const begin = code.indexOf("\nBEGIN;");
      expect(begin).toBeGreaterThan(0);
      expect(code.match(/\nBEGIN;/g)).toHaveLength(1);
      expect(code.match(/\nCOMMIT;/g)).toHaveLength(1);
      expect(code.indexOf("CREATE TEMP TABLE IF NOT EXISTS ao_p8_")).toBeLessThan(begin);
      const inv = code.slice(code.indexOf("INSERT INTO ao_p8_"), begin);
      expect(inv).toMatch(/COUNT\(\*\)/);
      expect(inv).not.toMatch(/SELECT\s+\*/); // never customer rows
      const tail = code.slice(code.lastIndexOf("\nCOMMIT;"));
      expect(tail).toMatch(/AS check,[\s\S]*AS ok,\s*NULL::text AS n/);
      // one statement after COMMIT: the final SELECT (UNION ALL of the probes
      // and the inventory) — no other statement starts at a line's head
      const after = tail.replace(/^\nCOMMIT;/, "");
      expect(after.trimStart()).toMatch(/^SELECT /);
      expect(after).not.toMatch(/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|BEGIN|TRUNCATE)\b/m);
      expect(after.trimEnd().endsWith(";")).toBe(true);
    });
    it(`${name}: every SECURITY DEFINER function pins search_path and revokes EXECUTE from PUBLIC / anon`, () => {
      for (const m of text.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(([^)]*)\)\s*\n?RETURNS[^\n]*SECURITY DEFINER[^\n]*/g)) {
        expect(m[0], m[1]).toMatch(/SET search_path = public/);
        // node_visible is the one recorded exception: a policy written for
        // every role calls it, so its grants are kept exactly (the header
        // says why); every function this package adds revokes.
        if (m[1] === "node_visible") { expect(text).toMatch(/EXECUTE is deliberately left as it is/); continue; }
        expect(text, `${m[1]} REVOKE`).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${m[1]}\\([^)]*\\) FROM PUBLIC, anon`));
      }
    });
  }
});

// ── 20261203 ────────────────────────────────────────────────────────────────
describe("20261203 — ORG-13 rail, node_visible org-scoped, ORG-6 pin, timezone an Admin's", () => {
  it("node_visible/6 re-created from its NEWEST earlier definition with exactly one line changed (the team lookup)", () => {
    const earlier = definitions("node_visible", before(A_FILE), 6);
    expect(earlier.length).toBeGreaterThanOrEqual(2);
    const [liveFile, live] = earlier.at(-1)!;
    expect(liveFile >= "20261041_rp_phase5_node_visible_additive.sql").toBe(true);
    const next = definitions("node_visible", [A_FILE], 6)[0][1];
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual(["    FROM team_members WHERE uid = auth.uid();"]);
    expect(onlyInB).toEqual(["    FROM team_members WHERE uid = auth.uid() AND org_id = p_org;"]);
  });

  it("TRIPWIRE: the newest node_visible/6 in the whole sequence still scopes its team lookup to the node's org", () => {
    const [file, text] = definitions("node_visible", FILES, 6).at(-1)!;
    expect(file >= A_FILE, file).toBe(true);
    expect(text, `${file} dropped ORG-13's org filter`).toMatch(/FROM team_members WHERE uid = auth\.uid\(\) AND org_id = p_org;/);
  });

  it("the three per-key policies are re-created from their NEWEST definition with one added line: timezone → is_org_admin", () => {
    for (const name of ["org_config_key_writes_ins", "org_config_key_writes_upd", "org_config_key_writes_del"]) {
      const earlierFile = before(A_FILE).filter((f) => read(f).includes(`CREATE POLICY ${name} ON org_configurations`)).at(-1)!;
      expect(earlierFile).toBe("20260818_followups_rls.sql");
      const old = policyBlock(read(earlierFile), name);
      const next = policyBlock(A, name);
      const { onlyInA, onlyInB } = lineDiff(old, next);
      expect(onlyInA).toEqual([]);
      expect([...new Set(onlyInB)]).toEqual(["    WHEN 'timezone' THEN is_org_admin(org_id)"]);
      expect(next).toMatch(/AS RESTRICTIVE/);
    }
  });

  it("the rail: BEFORE INSERT OR UPDATE OF team_id, org_id; a SECURITY DEFINER read of the team's org (RLS cannot hide it); check_violation", () => {
    const fn = definitions("enforce_team_member_org", [A_FILE])[0][1];
    expect(fn).toMatch(/SECURITY DEFINER SET search_path = public/);
    expect(fn).toMatch(/SELECT org_id INTO v_team_org FROM teams WHERE id = NEW\.team_id;/);
    expect(fn).toMatch(/IF FOUND AND NEW\.org_id IS DISTINCT FROM v_team_org THEN/);
    expect(fn).toMatch(/ERRCODE = 'check_violation'/);
    expect(A).toMatch(/CREATE TRIGGER trg_team_members_org_rail\s+BEFORE INSERT OR UPDATE OF team_id, org_id ON team_members\s+FOR EACH ROW EXECUTE FUNCTION enforce_team_member_org\(\);/);
    expect(A).toMatch(/CREATE TRIGGER trg_teams_org_move_rail\s+BEFORE UPDATE OF org_id ON teams/);
    expect(A).toMatch(/REVOKE ALL ON FUNCTION enforce_team_member_org\(\) FROM PUBLIC, anon, authenticated;/);
  });

  it("ORG-13 dw3 (review fix): the database refuses a person's new or changed supervisor who is not an ACTIVE member of the team's workspace; a rename, a clear and a no-uid write pass", () => {
    const fn = A.slice(A.indexOf("CREATE OR REPLACE FUNCTION enforce_team_supervisor_member()"), A.indexOf("REVOKE ALL ON FUNCTION enforce_team_supervisor_member()"));
    expect(fn).toMatch(/RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/);
    expect(fn).toMatch(/IF auth\.uid\(\) IS NULL OR NEW\.supervisor_user_id IS NULL THEN\n    RETURN NEW;/);
    expect(fn).toMatch(/IF TG_OP = 'UPDATE'\n     AND NEW\.supervisor_user_id IS NOT DISTINCT FROM OLD\.supervisor_user_id\n     AND NEW\.org_id IS NOT DISTINCT FROM OLD\.org_id THEN\n    RETURN NEW;/);
    expect(fn).toMatch(/WHERE m\.org_id = NEW\.org_id AND m\.uid = NEW\.supervisor_user_id AND m\.status = 'active'\) THEN\n    RAISE EXCEPTION '[^']*(?:''[^']*)*'\n      USING ERRCODE = 'check_violation';/);
    expect(A).toContain("REVOKE ALL ON FUNCTION enforce_team_supervisor_member() FROM PUBLIC, anon, authenticated;");
    expect(A).toMatch(/CREATE TRIGGER trg_teams_supervisor_member_rail\n  BEFORE INSERT OR UPDATE OF supervisor_user_id, org_id ON teams\n  FOR EACH ROW EXECUTE FUNCTION enforce_team_supervisor_member\(\);/);
    // existing teams are counted, never changed
    expect(A).not.toMatch(/UPDATE teams/);
    const inv = A.slice(A.indexOf("INSERT INTO ao_p8_20261203_inventory"), A.indexOf("\nBEGIN;"));
    expect(inv).toMatch(/teams whose supervisor is not an active member/);
  });

  it("rows that already break the rail are audited (machine rows) and removed INSIDE the transaction, audit first", () => {
    const tx = A.slice(A.indexOf("\nBEGIN;"), A.indexOf("\nCOMMIT;"));
    const audit = tx.indexOf("'TEAM_MEMBER_REMOVED', tm.team_id::text, 'team', tm.org_id, NULL");
    const del = tx.indexOf("DELETE FROM team_members tm USING teams t");
    expect(audit).toBeGreaterThan(0);
    expect(del).toBeGreaterThan(audit);
    expect(tx).toMatch(/'reason', 'cross_org_team_member'/);
  });

  it("ORG-6: one top-level ALTER pins acl_subject_in_bucket/4 (searchPathPin.test.ts's tripwire is flipped)", () => {
    expect(A).toMatch(/^ALTER FUNCTION acl_subject_in_bucket\(jsonb, text, text, text\[\]\) SET search_path = public;$/m);
  });

  it("node_visible's grants are left exactly as they are (no REVOKE / GRANT on it)", () => {
    expect(A).not.toMatch(/(REVOKE|GRANT)[^;]*ON FUNCTION node_visible/);
  });
});

// ── 20261204 ────────────────────────────────────────────────────────────────
describe("20261204 — revoke_member from its NEWEST body + ALOG-15 + ORG-7; ALOG-3's trigger", () => {
  const earlier = definitions("revoke_member", before(B_FILE));
  const [liveFile, live] = earlier.at(-1)!;
  const next = definitions("revoke_member", [B_FILE])[0][1];

  it("the newest earlier definition is found by scanning (20261161 today, never 20261042 / 20261043)", () => {
    expect(liveFile >= "20261161_notif_roundG_read_scope.sql").toBe(true);
    expect(live).toMatch(/UPDATE notifications SET org_tombstoned_at = NOW\(\)/);
    expect(live).toMatch(/active_collaborators = '\{\}'::text\[\]/);
  });

  it("removes exactly two lines (the grant strip's SET, the removal row's last argument line) and adds only the updated_at stamp, the counters, the prune block and the removal row's roles", () => {
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual([
      "     SET data = jsonb_set(data, '{grants}',",
      "                             'endedCheckouts', v_checkouts, 'revokedGrants', v_grants));",
      "    'endedCheckouts', v_checkouts, 'revokedGrants', v_grants",
    ]);
    const pruneStart = next.indexOf("  -- ORG-7 (admin-and-org Round G, 20261204)");
    const pruneEnd = next.indexOf("  -- Team and project rosters");
    const prune = next.slice(pruneStart, pruneEnd);
    const allowed = new Set([
      "  v_acl_libs int := 0;", "  v_acl_cols int := 0;", "  v_acl_docs int := 0;", "  v_acl_sets int := 0;",
      "  v_rule_probe jsonb;",
      "  v_scope_libs uuid[] := '{}'::uuid[];", "  v_scope_cols uuid[] := '{}'::uuid[];",
      "  -- ALOG-15 (admin-and-org Round G, 20261204): the strip stamps updated_at,",
      "  -- so the policy route's compare-and-set sees it and answers 409 to a save",
      "  -- built from a policy that still held this member's grant.",
      "     SET updated_at = NOW(), data = jsonb_set(data, '{grants}',",
      "                             'endedCheckouts', v_checkouts, 'revokedGrants', v_grants,",
      "                             -- ALOG-4 (20261204): the removal names the roles it ended.",
      "                             -- Fix pass 3: the collection and the headline role together (the",
      "                             -- headline is appended when the collection lacks it — an empty",
      "                             -- collection still names the role the member held).",
      ROLES_BEFORE,
      "                             'prunedAclGrants', v_acl_libs + v_acl_cols + v_acl_docs + v_acl_sets));",
      // fix pass 3 (ORG-7): the answer names where inherited entries can be
      "    'endedCheckouts', v_checkouts, 'revokedGrants', v_grants,",
      "    -- Fix pass 3 (ORG-7): where inherited index entries can be — the members",
      "    -- page passes this to prune_removed_member_acl_index, and skips it when",
      "    -- both lists are empty.",
      "    'aclIndexScope', jsonb_build_object('libraries', to_jsonb(v_scope_libs), 'collections', to_jsonb(v_scope_cols))",
      ...prune.split("\n"),
    ]);
    for (const l of onlyInB) expect(allowed.has(l), `unexpected added line: ${l}`).toBe(true);
    expect(onlyInB).toContain("     SET updated_at = NOW(), data = jsonb_set(data, '{grants}',");
    expect(next.slice(next.indexOf("'MEMBER_REMOVED'"))).toContain(ROLES_BEFORE);
  });

  it("fix pass 3 (ALOG-4): rolesBefore is the role collection with the headline appended when the collection lacks it — an empty collection still names the role held", () => {
    expect(next).not.toContain("COALESCE(v_member.roles, ARRAY[v_member.role])");
    expect(ROLES_BEFORE).toContain("CASE WHEN v_member.role IS NULL OR v_member.role = ANY(COALESCE(v_member.roles, '{}'::text[])) THEN COALESCE(v_member.roles, '{}'::text[]) ELSE array_append(COALESCE(v_member.roles, '{}'::text[]), v_member.role) END");
    // the same rule, in TypeScript, over the cases the review named
    const rolesBefore = (role: string | null, roles: string[] | null) =>
      role === null || (roles ?? []).includes(role) ? (roles ?? []) : [...(roles ?? []), role];
    expect(rolesBefore("Engineer-3", [])).toEqual(["Engineer-3"]); // the create-user seed that did not land
    expect(rolesBefore("Drafter", ["Viewer", "Drafter"])).toEqual(["Viewer", "Drafter"]);
    expect(rolesBefore("Admin", ["Viewer"])).toEqual(["Viewer", "Admin"]);
  });

  it("fix pass 3 (ORG-7): revoke_member returns aclIndexScope — the libraries and folders whose OWN acl carried the grant — and nothing else changes in the prune", () => {
    // libraries: read before the UPDATE (the template alone is not inherited)
    expect(next).toMatch(/SELECT COALESCE\(array_agg\(id\), '\{\}'::uuid\[\]\) INTO v_scope_libs FROM libraries\n   WHERE org_id = v_member\.org_id\n     AND acl @> v_rule_probe\n     AND v_member\.uid::text = ANY\(acl_allow_user_ids\(acl, NULL\)\);\n  UPDATE libraries/);
    // folders: the ids the prune itself rewrote (RETURNING id), counted the same
    expect(next).toMatch(/WITH pruned_cols AS \(\n    UPDATE collections[\s\S]*?RETURNING id\n  \)\n  SELECT COUNT\(\*\), COALESCE\(array_agg\(id\), '\{\}'::uuid\[\]\) INTO v_acl_cols, v_scope_cols FROM pruned_cols;/);
    expect(next).toMatch(/'aclIndexScope', jsonb_build_object\('libraries', to_jsonb\(v_scope_libs\), 'collections', to_jsonb\(v_scope_cols\)\)\n  \);\nEND;/);
  });

  it("MERGE (drafting-flow DF-P3, DEC-103): revoke_member's body carries no departure path — 20261195's org_members AFTER triggers do it — and the paste checks both triggers when 20261195 is in", () => {
    expect(next).not.toMatch(/return_departed_member_tickets|app\.ticket_departure|DROP TRIGGER[^;]*org_member_departure/);
    expect(B).not.toMatch(/org_member_departure_returns_tickets\(\)\s*(RETURNS|IS)|DROP TRIGGER IF EXISTS trg_org_member_departure/);
    expect(B).toContain("NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'revoke_member' AND (prosrc LIKE '%departed_member%' OR prosrc LIKE '%app.ticket_departure%'))");
    // memberDeparture.test.ts reads the newest revoke_member FILE whole: the name never appears in it
    expect(B).not.toContain("return_departed_member_tickets");
    expect(B).toMatch(/tg\.tgname IN \('trg_org_member_departure_status', 'trg_org_member_departure_delete'\)/);
    // the triggers 20261195 creates are exactly the two the probe names, on org_members
    const df = read("20261195_df_roundG_outcome_and_departure.sql");
    expect(df).toMatch(/CREATE TRIGGER trg_org_member_departure_status\n  AFTER UPDATE OF status ON org_members/);
    expect(df).toMatch(/CREATE TRIGGER trg_org_member_departure_delete\n  AFTER DELETE ON org_members/);
  });

  it("the prune runs on REMOVE only, after the grant strip and before the roster deletes and the membership delete — one transaction", () => {
    const at = (s: string) => next.indexOf(s);
    expect(at("IF p_mode = 'suspend' THEN")).toBeLessThan(at("UPDATE libraries\n     SET acl = acl_without_user_allow"));
    expect(at("GET DIAGNOSTICS v_grants = ROW_COUNT;")).toBeLessThan(at("UPDATE libraries\n     SET acl = acl_without_user_allow"));
    for (const t of ["documents", "document_sets"]) {
      expect(next).toMatch(new RegExp(`UPDATE ${t}\\n     SET acl = acl_without_user_allow\\(acl, ARRAY\\[v_member\\.uid::text\\]\\),\\n         acl_index = acl_index_without_user_allow\\(acl_index, ARRAY\\[v_member\\.uid::text\\]\\)\\n   WHERE org_id = v_member\\.org_id`));
    }
    // fix pass 3: the folder prune is the same UPDATE inside a CTE that returns the ids it rewrote
    expect(next).toMatch(/UPDATE collections\n       SET acl = acl_without_user_allow\(acl, ARRAY\[v_member\.uid::text\]\),\n           acl_index = acl_index_without_user_allow\(acl_index, ARRAY\[v_member\.uid::text\]\)\n     WHERE org_id = v_member\.org_id\n       AND acl @> v_rule_probe\n       AND v_member\.uid::text = ANY\(acl_allow_user_ids\(acl, NULL\)\)\n    RETURNING id/);
    expect(next).toMatch(/default_new_acl = acl_without_user_allow\(default_new_acl, ARRAY\[v_member\.uid::text\]\)/);
    expect(at("MEMBER_ACL_GRANTS_PRUNED")).toBeLessThan(at("DELETE FROM subscriptions WHERE org_id = v_member.org_id"));
    // fix pass: each scan is narrowed by a binary jsonb test built once — no
    // text cast of any row — before the exact acl_allow_user_ids check
    expect(next).not.toMatch(/strpos\(|acl::text|acl_index::text/);
    expect(next).toMatch(/v_rule_probe := jsonb_build_object\('rules', jsonb_build_array\(jsonb_build_object\('subject', jsonb_build_object\('type', 'user', 'id', v_member\.uid::text\)\)\)\);/);
    // review fix (57014): the in-statement prune rewrites only the nodes
    // whose OWN acl / template carries the rule — never a scan of the
    // inheriting descendants' acl_index (that moved to the chunked RPC)
    expect(next).not.toMatch(/acl_index @\?|v_bucket_probe/);
    expect(next).toMatch(/AND \(acl @> v_rule_probe OR default_new_acl @> v_rule_probe\)\n     AND v_member\.uid::text = ANY\(acl_allow_user_ids\(acl, NULL\) \|\| acl_allow_user_ids\(default_new_acl, NULL\)\);/);
    expect(next.match(/AND acl @> v_rule_probe\n     AND v_member\.uid::text = ANY\(acl_allow_user_ids\(acl, NULL\)\);/g)).toHaveLength(3);
    expect(at("DELETE FROM subscriptions WHERE org_id = v_member.org_id")).toBeLessThan(at("DELETE FROM org_members WHERE id = p_member_id;"));
  });

  it("review fix (57014) + fix pass 3: the inherited acl_index entries are stripped by a chunked RPC keyed on the carriers — Admin or server only, never a current member, a keyset LIMIT per statement, no workspace-wide scan, audited per chunk", () => {
    const fn = definitions("prune_removed_member_acl_index", [B_FILE])[0][1];
    expect(fn).toMatch(/^CREATE OR REPLACE FUNCTION prune_removed_member_acl_index\(p_org_id uuid, p_uid uuid, p_library_ids uuid\[\], p_collection_ids uuid\[\], p_phase text DEFAULT 'documents', p_after uuid DEFAULT NULL, p_limit integer DEFAULT 1000\)\nRETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/);
    expect(B).toContain("DROP FUNCTION IF EXISTS prune_removed_member_acl_index(uuid, uuid, integer);");
    expect(fn).toContain("v_limit int := LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 5000);");
    // authority: an active Admin of the org by the role collection, or the server
    expect(fn).toMatch(/IF v_actor IS NULL THEN\n    IF COALESCE\(auth\.role\(\), ''\) <> 'service_role' THEN\n      RAISE EXCEPTION/);
    expect(fn).toContain("me.status = 'active' AND (me.role = 'Admin' OR me.roles && ARRAY['Admin']::text[])");
    // never strips a current member's access
    expect(fn).toMatch(/IF EXISTS \(SELECT 1 FROM org_members m WHERE m\.org_id = p_org_id AND m\.uid = p_uid\) THEN\n    RAISE EXCEPTION/);
    // the scope is kept to the workspace; an empty scope returns before any node table is read
    expect(fn).toMatch(/INTO v_libs FROM libraries\n   WHERE org_id = p_org_id AND id = ANY\(COALESCE\(p_library_ids, '\{\}'::uuid\[\]\)\);/);
    expect(fn).toMatch(/INTO v_cols FROM collections\n   WHERE org_id = p_org_id AND id = ANY\(COALESCE\(p_collection_ids, '\{\}'::uuid\[\]\)\);/);
    const emptyReturn = fn.indexOf("IF cardinality(v_libs) = 0 AND cardinality(v_cols) = 0 THEN");
    expect(emptyReturn).toBeGreaterThan(0);
    expect(fn.slice(emptyReturn, fn.indexOf("END IF;", emptyReturn))).toMatch(/RETURN jsonb_build_object\('pruned', 0, 'examined', 0, 'phase', NULL, 'after', NULL, 'limit', v_limit, 'done', true\);/);
    for (const t of ["documents", "collections", "document_sets"]) expect(fn.indexOf(`SELECT id FROM ${t}\n`)).toBeGreaterThan(emptyReturn);
    expect(fn.indexOf("v_folders FROM collections")).toBeGreaterThan(emptyReturn);
    // every candidate read is keyed on the scope's indexed columns and a keyset cursor, LIMIT-bounded
    expect(fn).toMatch(/SELECT id FROM documents\n       WHERE org_id = p_org_id AND \(library_id = ANY\(v_libs\) OR collection_id = ANY\(v_folders\)\)\n         AND \(p_after IS NULL OR id > p_after\)\n       ORDER BY id LIMIT v_limit\) c;/);
    expect(fn).toMatch(/WHERE org_id = p_org_id AND \(id = ANY\(v_cols\) OR path_ids && v_cols\);/);
    expect(fn).toMatch(/SELECT id FROM collections\n       WHERE org_id = p_org_id AND \(library_id = ANY\(v_libs\) OR path_ids && v_cols\)\n         AND \(p_after IS NULL OR id > p_after\)\n       ORDER BY id LIMIT v_limit\) c;/);
    expect(fn).toMatch(/SELECT id FROM document_sets\n       WHERE org_id = p_org_id AND library_id = ANY\(v_libs\)\n         AND \(p_after IS NULL OR id > p_after\)\n       ORDER BY id LIMIT v_limit\) c;/);
    // no read of a node table is unkeyed: every "FROM <node table>" is a scope, a carrier or a candidate read
    expect(fn).not.toMatch(/WHERE org_id = p_org_id AND acl_index @\?/);
    // the write: only the examined rows that still list the person, acl_index only
    for (const t of ["documents", "collections", "document_sets"]) {
      expect(fn).toMatch(new RegExp(`UPDATE ${t} SET acl_index = acl_index_without_user_allow\\(acl_index, ARRAY\\[p_uid::text\\]\\)\\n\\s+WHERE id = ANY\\(COALESCE\\(v_ids, '\\{\\}'::uuid\\[\\]\\)\\) AND acl_index @\\? v_probe;`));
    }
    expect(fn).not.toMatch(/SET acl = |UPDATE libraries/);
    // the cursor: a full page resumes after its last row, a short page moves to the next phase
    expect(fn).toMatch(/IF v_examined = v_limit THEN\n    v_next_phase := v_phase;\n    v_after := v_ids\[v_examined\];/);
    expect(fn).toContain("v_next_phase := CASE v_phase WHEN 'documents' THEN 'collections' WHEN 'collections' THEN 'document_sets' ELSE NULL END;");
    expect(fn).toMatch(/'MEMBER_ACL_GRANTS_PRUNED'[\s\S]*'phase', 'acl_index'/);
    expect(fn).toMatch(/RETURN jsonb_build_object\('pruned', v_pruned, 'examined', v_examined,\n\s+'phase', v_next_phase, 'after', v_after,\n\s+'limit', v_limit, 'done', v_next_phase IS NULL\);/);
    expect(B).toMatch(/REVOKE ALL ON FUNCTION prune_removed_member_acl_index\(uuid, uuid, uuid\[\], uuid\[\], text, uuid, integer\) FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION prune_removed_member_acl_index\(uuid, uuid, uuid\[\], uuid\[\], text, uuid, integer\) TO authenticated, service_role;/);
    // the probes the paste shows
    expect(B).toContain("AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'revoke_member' AND prosrc LIKE '%acl_index @?%'),");
    expect(B).toContain("AND (SELECT COUNT(*) = 1 FROM pg_proc WHERE proname = 'prune_removed_member_acl_index')");
  });

  it("keeps the newest body's rails: SECURITY DEFINER, pinned search_path, NULL uid refused, EXECUTE for authenticated only (DRLS-16)", () => {
    expect(next).toMatch(/RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/);
    expect(next).toMatch(/IF v_actor IS NULL THEN\s+RAISE EXCEPTION 'revoke_member: must be called by a signed-in member';/);
    expect(B).toMatch(/REVOKE ALL ON FUNCTION revoke_member\(uuid, text\) FROM PUBLIC, anon;\s*GRANT EXECUTE ON FUNCTION revoke_member\(uuid, text\) TO authenticated;/);
  });

  it("stops before anything is written when 20261161 has not been pasted (its tombstone column)", () => {
    const pre = B.slice(0, B.indexOf("CREATE TEMP TABLE"));
    expect(pre).toMatch(/column_name = 'org_tombstoned_at'[\s\S]*RAISE EXCEPTION 'Paste 20261161_notif_roundG_read_scope\.sql first/);
  });

  it("the helpers are pure: IMMUTABLE, SECURITY INVOKER, search_path pinned, EXECUTE revoked from every app role", () => {
    for (const fn of ["acl_allow_user_ids", "acl_without_user_allow", "acl_index_without_user_allow"]) {
      const def = definitions(fn, [B_FILE])[0][1];
      expect(def, fn).toMatch(/LANGUAGE sql IMMUTABLE SET search_path = public AS \$\$/);
      expect(def, fn).not.toMatch(/SECURITY DEFINER/);
      expect(B).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`));
    }
    // a deny is never pruned: the predicate excludes effect = 'deny'
    expect(definitions("acl_without_user_allow", [B_FILE])[0][1]).toMatch(/COALESCE\(r->>'effect', ''\) <> 'deny'/);
  });

  it("ALOG-3: BEFORE DELETE on libraries, counts every cascade target, writes LIBRARY_DELETED in the same statement", () => {
    const fn = definitions("audit_library_delete", [B_FILE])[0][1];
    expect(fn).toMatch(/SECURITY DEFINER SET search_path = public/);
    for (const c of ["FROM collections WHERE library_id = OLD.id", "FROM documents WHERE library_id = OLD.id",
      "FROM document_versions v JOIN documents d ON d.id = v.record_id", "FROM document_holds h JOIN documents d ON d.id = h.document_id",
      "FROM tickets t"]) expect(fn, c).toContain(c);
    expect(fn).toMatch(/'LIBRARY_DELETED', OLD\.id::text, 'library', OLD\.org_id, v_actor/);
    expect(fn).toMatch(/RETURN OLD;/);
    expect(B).toMatch(/CREATE TRIGGER trg_library_delete_audit\s+BEFORE DELETE ON libraries\s+FOR EACH ROW EXECUTE FUNCTION audit_library_delete\(\);/);
  });

  it("the stale-grant backfill touches only grants naming someone with NO membership row in the node's workspace, one machine audit row per workspace", () => {
    const tx = B.slice(B.indexOf("\nBEGIN;"), B.indexOf("\nCOMMIT;"));
    expect(tx.match(/WHERE NOT EXISTS \(SELECT 1 FROM org_members m WHERE m\.org_id = t\.org_id AND m\.uid::text = u\)/g)).toHaveLength(4);
    expect(tx).not.toMatch(/m\.status/); // an inactive or suspended member keeps their grants
    expect(tx).toMatch(/'ACL_STALE_GRANTS_PRUNED', b\.org_id::text, 'org', b\.org_id, NULL/);
  });
});

// ── the SQL prune is the exact image of the rebuild ─────────────────────────
// A JS port of acl_without_user_allow / acl_index_without_user_allow, checked
// against lib/acl.ts buildAclIndexFromChain: pruning X's ALLOW rules from
// every node and then rebuilding gives the same grants as stripping X from
// the stored index's allow buckets.
function jsAclWithoutUserAllow(acl: AccessControl | null, uids: string[]): AccessControl | null {
  if (!acl || !Array.isArray(acl.rules)) return acl;
  return { ...acl, rules: acl.rules.filter((r) => !(r.subject?.type === "user" && r.effect !== "deny" && uids.includes(r.subject.id))) };
}
function jsIndexWithoutUserAllow(idx: AclIndex | null, uids: string[]): AclIndex | null {
  if (!idx?.allow?.users) return idx;
  const users = Object.fromEntries(Object.entries(idx.allow.users).map(([k, v]) => [k, (v ?? []).filter((u) => !uids.includes(u))]));
  return { ...idx, allow: { ...idx.allow, users: users as AclIndex["allow"]["users"] } };
}
/** The grants an index carries, as a set of "side:kind:action:id". */
function grants(idx: AclIndex | null): string[] {
  const out: string[] = [];
  for (const side of ["allow", "deny"] as const) {
    const b = idx?.[side] as Record<string, Record<string, string[]>> | undefined;
    for (const [kind, actions] of Object.entries(b ?? {})) for (const [a, ids] of Object.entries(actions ?? {})) for (const id of ids ?? []) out.push(`${side}:${kind}:${a}:${id}`);
  }
  return out.sort();
}

describe("ORG-7 — the index strip equals the rebuild after the prune", () => {
  const rule = (effect: "allow" | "deny", type: AccessRule["subject"]["type"], id: string, actions: AccessRule["actions"]): AccessRule => ({ effect, subject: { type, id }, actions });
  const lib: AccessControl = { inherit: true, visibility: "private", rules: [
    rule("allow", "user", "X", ["read", "download"]), rule("deny", "user", "X", ["publish"]),
    rule("allow", "user", "Y", ["read"]), rule("allow", "team", "T1", ["read"]), rule("allow", "role", "Engineer-1", ["upload"]),
  ] };
  const folder: AccessControl = { inherit: true, rules: [rule("allow", "user", "X", ["write"]), rule("deny", "user", "Y", ["write"])] };
  const doc: AccessControl = { inherit: false, rules: [rule("allow", "user", "X", ["admin"]), rule("allow", "org", "o1", ["read"])] };
  const chains: Array<Array<AccessControl | undefined>> = [[lib], [lib, folder], [lib, folder, doc], [undefined, folder], [lib, undefined, doc]];

  it.each(chains.map((c, i) => [i, c] as const))("chain %i: strip(build(chain)) has the same grants as build(prune(chain))", (_i, chain) => {
    const stripped = jsIndexWithoutUserAllow(buildAclIndexFromChain(chain), ["X"]);
    const rebuilt = buildAclIndexFromChain(chain.map((a) => a ? jsAclWithoutUserAllow(a, ["X"]) ?? undefined : undefined));
    expect(grants(stripped)).toEqual(grants(rebuilt));
    // X keeps every deny, and loses every allow
    expect(grants(stripped).filter((g) => g.startsWith("allow:users:") && g.endsWith(":X"))).toEqual([]);
    expect(grants(stripped).filter((g) => g.startsWith("deny:users:") && g.endsWith(":X"))).toEqual(grants(buildAclIndexFromChain(chain)).filter((g) => g.startsWith("deny:users:") && g.endsWith(":X")));
  });
});
