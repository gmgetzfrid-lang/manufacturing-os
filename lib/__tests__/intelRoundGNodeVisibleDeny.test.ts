// intelligence Round G, I-12 DOCUMENT ACL BOUNDARY — 20261212's
// node_visible: an explicit read deny binds for every subject (DACL-12 c1)
// and on a normal row (IEDGE-12 c2 / DACL-1's read-time half).
//
//   · DEC-30 one-paste shape (counts-only TEMP inventory before BEGIN, one
//     BEGIN / COMMIT, one final (check, ok, n) SELECT).
//   · DEC-90 ruling R2 and its follow-up (2026-10-14): the KACL-5 index is
//     standalone before BEGIN (every paste); node_visible/6 is re-created
//     only when the operator switch app.i12_deny_binding is 'on' (default
//     OFF — its SET LOCAL line ships commented out) AND the six drop-box
//     precondition counts are 0 (a DO block EXECUTEs the definition, else a
//     NOTICE naming why). Every outcome runs on PostgreSQL 16 in
//     lib/__tests__/rls/intelI12DropBoxGate.test.ts (npm run test:db).
//   · node_visible/6 re-created from its NEWEST earlier definition — found by
//     scanning supabase/migrations, so a parallel re-creation folded in at a
//     merge is diffed against, never skipped — with exactly the lines below
//     changed, and its grants left as they are (20261203's recorded
//     exception: a policy written for every role calls it).
//   · The agreement matrix: the same (visibility, rules, principal) cases
//     judged by the app (lib/permissions canReadNode over the chain) and by a
//     line-for-line port of the new SQL body over the index lib/acl builds
//     from the same rules — and the port is pinned to what the SQL returned
//     on a throwaway PostgreSQL 16 (recorded below as pg16; the run is
//     described on DACL-12 — on a normal row the SQL reads no allow, so the
//     cases that add an allow for the app's sake return the same there). They
//     agree on every case except the named residuals.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildAclIndexFromRules } from "@/lib/acl";
import { canReadNode, type Principal } from "@/lib/permissions";
import type { AccessRule, AclIndex, NodeVisibility, PermissionAction, Role } from "@/types/schema";

const DIR = join(process.cwd(), "supabase", "migrations");
const FILES = readdirSync(DIR).filter((f) => /^\d{8}_.*\.sql$/.test(f)).sort();
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const FILE = "20261212_intel_roundG_node_visible_deny.sql";
const SQL = read(FILE);

function lineDiff(a: string, b: string) {
  const AL = a.split("\n"), BL = b.split("\n");
  return { onlyInA: AL.filter((l) => !BL.includes(l)), onlyInB: BL.filter((l) => !AL.includes(l)) };
}

/** Every CREATE [OR REPLACE] FUNCTION <name>( … of the given arity in the
 *  given files, in order, with the body up to its closing dollar quote. */
function definitions(name: string, files: string[], arity: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${name}\\s*\\(`, "g");
  for (const f of files) {
    const s = read(f);
    for (const m of s.matchAll(re)) {
      const lineStart = s.lastIndexOf("\n", m.index!) + 1;
      if (/^\s*--/.test(s.slice(lineStart, m.index!))) continue;
      const params = s.slice(m.index! + m[0].length, s.indexOf(")", m.index! + m[0].length));
      const n = params.trim() === "" ? 0 : params.split(",").length;
      if (n !== arity) continue;
      const open = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/g;
      open.lastIndex = m.index!;
      const tag = open.exec(s)!;
      const end = s.indexOf(tag[0], tag.index + tag[0].length);
      out.push([f, s.slice(m.index!, end + tag[0].length + 1)]);
    }
  }
  return out;
}

describe("20261212 — DEC-30 one-paste shape", () => {
  it("counts-only TEMP inventory BEFORE the transaction, one BEGIN / COMMIT, one final (check, ok, n) SELECT", () => {
    const code = SQL.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
    const begin = code.indexOf("\nBEGIN;");
    expect(begin).toBeGreaterThan(0);
    expect(code.match(/\nBEGIN;/g)).toHaveLength(1);
    expect(code.match(/\nCOMMIT;/g)).toHaveLength(1);
    const tmp = code.indexOf("DROP TABLE IF EXISTS pg_temp.intel_i12_20261212_inventory;\nCREATE TEMP TABLE intel_i12_20261212_inventory (ord int, check_name text, n bigint, pre boolean);");
    expect(tmp).toBeGreaterThan(0);
    expect(tmp).toBeLessThan(begin);
    const inv = code.slice(code.indexOf("INSERT INTO intel_i12_20261212_inventory"), begin);
    expect(inv).toMatch(/COUNT\(\*\)/);
    expect(inv).not.toMatch(/SELECT\s+\*/);
    const tail = code.slice(code.lastIndexOf("\nCOMMIT;"));
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,\s*NULL::text AS n/);
    const after = tail.replace(/^\nCOMMIT;/, "");
    expect(after.trimStart()).toMatch(/^SELECT /);
    expect(after).not.toMatch(/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|BEGIN|TRUNCATE)\b/m);
    expect(after.trimEnd().endsWith(";")).toBe(true);
  });

  it("KACL-5 (second review fix; DEC-90 R2 at the I-12 merge): the native-source lookup the bytes door makes on every sign is indexed — a standalone partial index BEFORE the transaction (every paste, whatever the gate decides), after the inventory, probed in the result set", () => {
    const code = SQL.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
    const begin = code.indexOf("\nBEGIN;"), commit = code.indexOf("\nCOMMIT;");
    const idx = code.indexOf("CREATE INDEX IF NOT EXISTS document_versions_source_file_key_idx\n  ON document_versions (source_file_key) WHERE source_file_key IS NOT NULL;");
    expect(idx).toBeGreaterThan(code.indexOf("INSERT INTO intel_i12_20261212_inventory"));
    expect(idx).toBeLessThan(begin);
    expect(code.match(/CREATE INDEX/g)).toHaveLength(1);
    expect(code.slice(commit)).toMatch(/indexname = 'document_versions_source_file_key_idx'/);
    expect(code.slice(commit)).toMatch(/indexdef LIKE '%WHERE \(source_file_key IS NOT NULL\)%'/);
    const header = SQL.slice(0, SQL.indexOf("-- ── 0. pre-apply inventory"));
    expect(header).toMatch(/1\. ALWAYS, on every paste — the KACL-5 index/);
    expect(header).toMatch(/The index is the\s+--\s+I-12 deploy's ONLY prerequisite\./);
    // the route's two lookups are unchanged — the index only changes their cost
    const route = readFileSync(join(process.cwd(), "app/api/storage/download-url/route.ts"), "utf8");
    expect(route).toMatch(/for \(const col of \["file_url", "source_file_key"\] as const\)/);
    expect(route).toMatch(/document_versions_source_file_key_idx/);
  });

  it("DEC-90 R2 and its follow-up: node_visible/6 is re-created inside a DO block only when the operator switch is 'on' (default off, its SET LOCAL commented out) AND every precondition count is 0 — otherwise a NOTICE naming why and nothing changes; the header says what applies when and that the binding lands with intelligence I-30", () => {
    const code = SQL.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
    const begin = code.indexOf("\nBEGIN;"), commit = code.indexOf("\nCOMMIT;");
    const gate = code.slice(begin, commit);
    expect(gate).toMatch(/DO \$gate\$\nDECLARE\n  v_blockers bigint;\n  v_switch   boolean := COALESCE\(current_setting\('app\.i12_deny_binding', true\), ''\) = 'on';\nBEGIN\n  SELECT COALESCE\(SUM\(n\), 0\) INTO v_blockers FROM intel_i12_20261212_inventory WHERE pre;\n  UPDATE intel_i12_20261212_before SET switch_on = v_switch, applied = \(v_switch AND v_blockers = 0\);\n  IF v_switch AND v_blockers = 0 THEN\n    EXECUTE \$node_visible\$\nCREATE OR REPLACE FUNCTION node_visible\(/);
    expect(gate).toMatch(/\n\$\$;\n\$node_visible\$;\n  ELSE\n    RAISE NOTICE '20261212 left node_visible\/6 unchanged — the deny binding does not apply; the index was created\. Why: %\./);
    expect(gate).toContain("CASE WHEN NOT v_switch THEN 'it is held back by default: the operator switch app.i12_deny_binding is not ''on'' (DEC-90 — leave it off)' END");
    expect(gate).toContain("CASE WHEN v_blockers > 0 THEN v_blockers || ' drop-box precondition row(s) are not 0 (DEC-90 ruling R2) — read the precondition rows of the result' END");
    expect(gate).toMatch(/\n  END IF;\nEND\n\$gate\$;\n?$/);
    // the switch ships OFF: its only SET is a commented line inside the transaction; nothing else sets it
    expect(SQL).toContain("-- ⚠ DO NOT UNCOMMENT (DEC-90, 2026-10-14): the operator switch stays OFF and\n-- the binding lands with intelligence I-30 (header, item 2).\n-- SET LOCAL app.i12_deny_binding = 'on';");
    expect(code).not.toMatch(/SET\s+(LOCAL\s+)?app\.i12_deny_binding|set_config\(\s*'app\.i12_deny_binding'/i);
    expect(SQL.indexOf("-- SET LOCAL app.i12_deny_binding = 'on';")).toBeGreaterThan(SQL.indexOf("\nBEGIN;"));
    // the CREATE is the only statement in the transaction, and it is the gated one
    expect(code.slice(0, begin)).not.toMatch(/CREATE OR REPLACE FUNCTION/);
    // six precondition rows (pre = true), every other inventory row pre = false
    const inv = code.slice(code.indexOf("INSERT INTO intel_i12_20261212_inventory"), code.indexOf("DROP TABLE IF EXISTS pg_temp.intel_i12_20261212_before"));
    expect(code).toMatch(/CREATE TEMP TABLE intel_i12_20261212_before AS\nSELECT \(SELECT md5\(p\.prosrc\) FROM pg_proc p\n[^\n]*\) AS body_md5,\n       NULL::boolean AS switch_on, NULL::boolean AS applied;/);
    const rows = [...inv.matchAll(/SELECT (\d+), '((?:[^']|'')*)',[\s\S]*?, (true|false)(?: FROM|\n|$)/g)];
    expect(rows.map((r) => Number(r[1]))).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
    expect(rows.filter((r) => r[3] === "true").map((r) => r[2].slice(0, 15))).toEqual(["precondition P1", "precondition P2", "precondition P3", "precondition P4", "precondition P5", "precondition P6"]);
    // the result: 11 probes + 23 count rows = 34, as the header states
    const tail = code.slice(commit);
    expect(tail.match(/\nUNION ALL\n/g)).toHaveLength(11);
    const header = SQL.slice(0, SQL.indexOf("-- ── 0. pre-apply inventory"));
    expect(header).toMatch(/EXPECTED RESULT \(one result set, 34 rows: check, ok, n\)/);
    expect(header).toMatch(/WHAT APPLIES WHEN \(read this first\)/);
    expect(header).toMatch(/2\. BY DEFAULT, NOTHING ELSE: node_visible\/6 is left exactly as it was/);
    expect(header).toMatch(/only when BOTH hold: the operator switch app\.i12_deny_binding is 'on'/);
    expect(header).toMatch(/⚠ DO NOT SET THE SWITCH\s+--\s+\(DEC-90\)/);
    expect(header).toMatch(/THE SWITCH: paste the file AS IS\. Do NOT set app\.i12_deny_binding/);
    expect(header).toMatch(/The binding lands with\s+--\s+intelligence I-30 \(NODE_VISIBLE ALLOW-LIST, DROP BOXES AND INHERITED\s+--\s+GRANTS\)/);
    expect(header).toMatch(/Lifting the switch and the gate is I-30's\./);
    expect(header).toMatch(/THE GATE IS DECIDED AT PASTE TIME — WHY THE SWITCH STAYS OFF/);
    expect(tail).toMatch(/'operator switch: app\.i12_deny_binding was NOT set to ''on'' in this paste/);
    expect(tail).toMatch(/'deny binding gate \(DEC-90\): node_visible\/6 re-created with the binding — true only with the switch on AND every precondition count 0/);
    expect(tail).toMatch(/'node_visible\/6 is what the gate decided: applied/);
    expect(tail).toMatch(/IS NOT DISTINCT FROM \(SELECT b\.body_md5 FROM intel_i12_20261212_before b\)/);
    // the decision is read back from the TEMP row the gate wrote (a SET LOCAL switch is gone after COMMIT)
    expect(tail.match(/COALESCE\(\(SELECT b\.applied FROM intel_i12_20261212_before b\), false\)/g)!.length).toBe(5);
    expect(tail).not.toMatch(/current_setting/);
  });

  it("DACL-9 (second review fix): the counts-only inventory sizes the inherit-flag change — non-inheriting libraries and folders, those with descendants carrying their own ACL, and those descendants (private / hidden counted apart)", () => {
    const code = SQL.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
    const inv = code.slice(code.indexOf("INSERT INTO intel_i12_20261212_inventory"), code.indexOf("\nBEGIN;"));
    for (const label of [
      "'DACL-9: libraries whose own ACL sets inherit = false",
      "'DACL-9: folders whose own ACL sets inherit = false'",
      "'DACL-9: of those libraries and folders, the ones with a descendant folder or document carrying its own ACL'",
      "'DACL-9: folders and documents carrying their own ACL below a non-inheriting library or folder",
      "'DACL-9: of those descendants, private / hidden ones",
      "'KACL-5: document_versions rows with a source_file_key",
    ]) expect(inv, label).toContain(label);
    expect(inv.match(/acl->>'inherit' = 'false'/g)!.length).toBeGreaterThanOrEqual(10);
    expect(inv).not.toMatch(/SELECT\s+\*/);
  });

  it("third review fix (WRITES TOO), gated by DEC-90 R2: the header states that the RESTRICTIVE SELECT policy would refuse a named member's INSERT … RETURNING and UPDATE (a drop box's uploads), and the precondition counts every drop-box shape — before BEGIN, counts only", () => {
    const header = SQL.slice(0, SQL.indexOf("-- ── 0. pre-apply inventory"));
    expect(header).toMatch(/⚠ WRITES TOO — why the binding is gated/);
    expect(header).toMatch(/INSERT \.\.\. RETURNING/);
    expect(header).toMatch(/new\s+(--\s+)?row violates row-level security policy "documents_acl_select"/);
    expect(header).toMatch(/The same insert without RETURNING succeeds\./);
    expect(header).toMatch(/can no longer write it back or upload into\s+-- it \(WRITES TOO, above\)/);
    expect(header).toMatch(/Ruling R2: a drop box is a legitimate, common pattern and must\s+--\s+keep working\. So the re-creation is held back by default/);
    for (const p of ["P1 normal documents", "P2 private / hidden", "P3 / P4 the same two tests on folders", "P5 libraries whose own ACL", "P6 folders whose own ACL"]) expect(header, p).toContain(p);
    const code = SQL.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
    const inv = code.slice(code.indexOf("INSERT INTO intel_i12_20261212_inventory"), code.indexOf("\nBEGIN;"));
    for (const label of [
      "'precondition P1 (expect 0 for the binding to apply): normal documents whose acl_index denies READ to a subject (user, role, team or org) the same index does not deny UPLOAD",
      "'precondition P2 (expect 0): private / hidden documents whose acl_index denies read or discover to a ROLE, TEAM or ORG the same index does not deny UPLOAD",
      "'precondition P3 (expect 0): normal folders whose acl_index denies READ to a subject the same index does not deny UPLOAD",
      "'precondition P4 (expect 0): private / hidden folders whose acl_index denies read or discover to a ROLE, TEAM or ORG the same index does not deny UPLOAD'",
      "'precondition P5 (expect 0): libraries whose own ACL denies read",
      "'precondition P6 (expect 0): folders whose own ACL denies read",
      "'WRITES TOO: libraries with a default ACL for new documents",
    ]) expect(inv, label).toContain(label);
    // an index read-deny id is counted only where the same subject's upload list does not name it (P1–P4)
    expect(inv.match(/WHERE NOT COALESCE\(\(acl_index->'deny'->s\.subj->'upload'\) \? x\.id, false\)\)/g)!.length).toBe(4);
    // an ACL's read deny is excused only by a deny-upload rule of the SAME ACL for the same subject (P5's own ACL, P6); a default ACL's never
    expect(inv.match(/AND NOT EXISTS \(SELECT 1 FROM jsonb_array_elements\((l|c)\.acl->'rules'\) u/g)!.length).toBe(2);
    expect(inv).toMatch(/OR EXISTS \(SELECT 1 FROM jsonb_array_elements\(CASE WHEN jsonb_typeof\(l\.default_new_acl->'rules'\) = 'array' THEN l\.default_new_acl->'rules' ELSE '\[\]'::jsonb END\) r\n                WHERE r->>'effect' = 'deny' AND jsonb_typeof\(r->'actions'\) = 'array'\n                  AND \(\(r->'actions'\) \? 'read' OR \(\(r->'actions'\) \? 'discover' AND r->'subject'->>'type' IN \('role', 'team', 'org'\)\)\)\)\n/);
    // P2 / P4: role, team and org only — a user-scoped deny already bound in 20261203
    expect(inv.match(/WHERE NOT \(visibility IS NULL OR visibility = 'normal'\) AND acl_index IS NOT NULL\n   AND EXISTS \(SELECT 1 FROM unnest\(ARRAY\['roles', 'teams', 'orgs'\]\) s\(subj\), unnest\(ARRAY\['read', 'discover'\]\) a\(act\)/g)!.length).toBe(2);
    expect(inv).not.toMatch(/SELECT\s+\*/);
  });

  it("third review fix: paste BEFORE the I-12 branch deploys (the bytes door's source-key lookup scans until the index exists; the DACL-9 / DACL-10 counts are read before the deploy); DACL-9's labels say the grant half is withheld; DACL-10's ACL-NULL legacy libraries are counted", () => {
    const header = SQL.slice(0, SQL.indexOf("-- ── 0. pre-apply inventory"));
    expect(header).toMatch(/Paste it BEFORE the I-12\s+--\s+branch deploys\. The prerequisite is the index only/);
    expect(header).not.toMatch(/Independent of every other pending file/);
    expect(header).toMatch(/Its GRANTS are still dropped there \(I-12 third review\s+--\s+fix\)/);
    expect(header).toMatch(/DACL-10 \(inventory only\)/);
    const code = SQL.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
    const inv = code.slice(code.indexOf("INSERT INTO intel_i12_20261212_inventory"), code.indexOf("\nBEGIN;"));
    // DEC-90 R3 (2026-10-14): the grant half is carried by intelligence I-30 with the acl_index rebuild
    expect(header).toMatch(/correct semantics \(DEC-90 ruling R3, 2026-10-14/);
    expect(header).toMatch(/carried by intelligence I-30\s+--\s+together with the acl_index rebuild/);
    expect(inv).toContain("their grants are carried by intelligence I-30 with the acl_index rebuild — DEC-90 R3)'");
    expect(inv).toContain("upper bound of the rows intelligence I-30''s grant half widens");
    // DEC-90 R1 (2026-10-14): the legacy-list binding stays; the count is informational
    expect(header).toMatch(/Ruled by the integrator under DEC-90 \(R1,\s+--\s+2026-10-14\): the binding STAYS/);
    for (const label of [
      "'DACL-10: libraries whose ACL is NULL while read_access is restricted",
      "'DACL-10: documents filed in those libraries",
      "'DACL-10: (library, member) pairs where an active non-controller member, not the library''s owner, holds no role",
      "'DACL-10: of those pairs, distinct members — \"members the lists leave out\" (informational; read it before the I-12 deploy, DEC-90 R1)'",
      "'DACL-10: libraries whose ACL has no rule and normal visibility while read_access is restricted",
    ]) expect(inv, label).toContain(label);
    expect(inv).toMatch(/read_access <> '"ALL"'::jsonb/);
  });

  it("the only function it creates is node_visible/6: SECURITY DEFINER, search_path pinned, grants deliberately left as they are", () => {
    const creates = [...SQL.matchAll(/^CREATE OR REPLACE FUNCTION (\w+)\(/gm)].map((m) => m[1]);
    expect(creates).toEqual(["node_visible"]);
    expect(SQL).toMatch(/RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS \$\$/);
    expect(SQL).toMatch(/EXECUTE is deliberately left as it is/);
    expect(SQL).not.toMatch(/(REVOKE|GRANT)[^;]*ON FUNCTION node_visible/);
    // no table, policy or trigger is created or changed
    // (its TEMP tables only: the inventory and the body snapshot)
    expect(SQL).not.toMatch(/^\s*(CREATE|ALTER|DROP)\s+(TABLE|POLICY|TRIGGER)\b(?! IF EXISTS pg_temp\.intel_i12_20261212_(inventory|before);$)/m);
    expect(SQL.match(/^CREATE TEMP TABLE (\w+)/gm)).toEqual(["CREATE TEMP TABLE intel_i12_20261212_inventory", "CREATE TEMP TABLE intel_i12_20261212_before"]);
  });
});

describe("20261212 — node_visible/6 re-created from its newest earlier definition", () => {
  const earlier = definitions("node_visible", FILES.filter((f) => f < FILE), 6);
  const [liveFile, live] = earlier.at(-1)!;
  const next = definitions("node_visible", [FILE], 6);

  it("diffs against the newest earlier definition (20261203 or a later fold), line by line", () => {
    expect(liveFile >= "20261203_ao_roundG_team_members_org_rail.sql", liveFile).toBe(true);
    expect(next).toHaveLength(1);
    const { onlyInA, onlyInB } = lineDiff(live, next[0][1]);
    expect(onlyInA).toEqual([
      "  -- Fail-safe: normal/unset visibility is open to org members.",
      "  IF p_visibility IS NULL OR p_visibility = 'normal' THEN",
      // second review fix (cost): on a normal row the controller check and
      // the cascade wait for the deny — both now sit inside IF NOT v_normal
      "  IF is_org_controller(p_org) THEN",
      "  IF user_is_effective_owner(p_owner, p_collection, p_library, auth.uid()) THEN",
      "  -- Explicit deny of read/discover wins.",
      "  IF (p_acl_index->'deny'->'users'->'read') ? v_uid",
      "     OR (p_acl_index->'deny'->'users'->'discover') ? v_uid THEN",
    ]);
    expect(onlyInB).toEqual([
      "  v_normal boolean := (p_visibility IS NULL OR p_visibility = 'normal');",
      "  -- Fail-safe: normal/unset visibility is open to org members — unless the",
      "  -- row's chain-resolved acl_index carries an explicit READ deny (IEDGE-12 /",
      "  -- DACL-1, intelligence I-12). Fast path: no non-empty deny.<subject>.read",
      "  -- list means no table is read and the row is open, as before.",
      "  IF v_normal AND (p_acl_index IS NULL OR NOT EXISTS (",
      "       SELECT 1 FROM unnest(ARRAY['users', 'roles', 'teams', 'orgs']) s(subj)",
      "        WHERE jsonb_typeof(p_acl_index->'deny'->s.subj->'read') = 'array'",
      "          AND jsonb_array_length(p_acl_index->'deny'->s.subj->'read') > 0)) THEN",
      "  -- A NORMAL row reaching here carries a read deny: its controller check and",
      "  -- ownership cascade wait until that deny names the caller (below), so a",
      "  -- member it does not name costs the member and team reads only.",
      "  IF NOT v_normal THEN",
      "    IF is_org_controller(p_org) THEN",
      "      RETURN true;",
      "    END IF;",
      "  IF NOT v_normal THEN",
      "    IF user_is_effective_owner(p_owner, p_collection, p_library, auth.uid()) THEN",
      "      RETURN true;",
      "    END IF;",
      "  -- Explicit deny wins (DACL-12): a deny of read — or, on a hidden / private",
      "  -- row, of discover — naming the caller by uid, by ANY held role, by a team",
      "  -- or by the workspace refuses before any allow is read (lib/acl: a deny of",
      "  -- an action wins, OWN-8).",
      "  IF EXISTS (",
      "       SELECT 1 FROM unnest(CASE WHEN v_normal THEN ARRAY['read'] ELSE ARRAY['read', 'discover'] END) a(act)",
      "        WHERE (p_acl_index->'deny'->'users'->a.act) ? v_uid",
      "           OR (p_acl_index->'deny'->'orgs'->a.act) ? p_org::text",
      "           OR EXISTS (SELECT 1 FROM unnest(COALESCE(v_roles, '{}'::text[])) r",
      "                       WHERE (p_acl_index->'deny'->'roles'->a.act) ? r)",
      "           OR EXISTS (SELECT 1 FROM unnest(COALESCE(v_teams, '{}'::text[])) t",
      "                       WHERE (p_acl_index->'deny'->'teams'->a.act) ? t)) THEN",
      "    -- On a normal row the deny names the caller: a controller and the",
      "    -- effective owner still read it (asked only now); anyone else does not.",
      "    IF v_normal THEN",
      "      IF is_org_controller(p_org) THEN",
      "        RETURN true;",
      "      END IF;",
      "      RETURN COALESCE(user_is_effective_owner(p_owner, p_collection, p_library, auth.uid()), false);",
      "    END IF;",
      "  -- A normal row the deny does not name stays open (the fail-safe default).",
      "  IF v_normal THEN",
    ]);
  });

  it("second review fix (cost): on a NORMAL row the roles and teams are read first and a row the deny does not name returns true before any controller check or ownership cascade; a private / hidden row keeps 20261203's controller → owner order", () => {
    const body = next[0][1];
    const at = (s: string, from = 0) => { const i = body.indexOf(s, from); expect(i, s).toBeGreaterThan(0); return i; };
    // private / hidden: the controller check and the cascade are guarded by IF NOT v_normal, before the member read
    const guardCtl = at("  IF NOT v_normal THEN\n    IF is_org_controller(p_org) THEN\n      RETURN true;\n    END IF;\n  END IF;");
    const memberRead = at("SELECT role, COALESCE(roles, ARRAY[role]) INTO v_role, v_roles FROM org_members");
    const guardOwner = at("  IF NOT v_normal THEN\n    IF user_is_effective_owner(p_owner, p_collection, p_library, auth.uid()) THEN");
    const teams = at("FROM team_members WHERE uid = auth.uid() AND org_id = p_org;");
    const deny = at("WHERE (p_acl_index->'deny'->'users'->a.act) ? v_uid");
    // normal: the deny that names the caller asks the controller tier, then the cascade — only there
    const normalNamed = at("    IF v_normal THEN\n      IF is_org_controller(p_org) THEN\n        RETURN true;\n      END IF;\n      RETURN COALESCE(user_is_effective_owner(p_owner, p_collection, p_library, auth.uid()), false);\n    END IF;\n    RETURN false;", deny);
    const normalOpen = at("  IF v_normal THEN\n    RETURN true;\n  END IF;", normalNamed);
    expect([guardCtl, memberRead, guardOwner, teams, deny, normalNamed, normalOpen]).toEqual([guardCtl, memberRead, guardOwner, teams, deny, normalNamed, normalOpen].sort((x, y) => x - y));
    // every call of the controller check and of the cascade is inside a v_normal branch
    expect(body.match(/is_org_controller\(p_org\)/g)).toHaveLength(2);
    expect(body.match(/user_is_effective_owner\(/g)).toHaveLength(2);
  });

  it("order: normal fast path → controller → owner → no-index refusal → team lookup → deny → normal open → allow", () => {
    const body = next[0][1];
    const at = (s: string) => { const i = body.indexOf(s); expect(i, s).toBeGreaterThan(0); return i; };
    const seq = [
      "IF v_normal AND (p_acl_index IS NULL OR NOT EXISTS (",
      "IF is_org_controller(p_org) THEN",
      "IF user_is_effective_owner(p_owner, p_collection, p_library, auth.uid()) THEN",
      "IF p_acl_index IS NULL THEN",
      "FROM team_members WHERE uid = auth.uid() AND org_id = p_org;",
      "WHERE (p_acl_index->'deny'->'users'->a.act) ? v_uid",
      "  IF v_normal THEN\n    RETURN true;",
      "RETURN acl_subject_in_bucket(p_acl_index->'allow', v_uid, v_role, v_teams)",
    ].map(at);
    expect([...seq].sort((a, b) => a - b)).toEqual(seq);
  });

  it("TRIPWIRE: the newest node_visible/6 in the whole sequence keeps the every-subject deny, the normal read-deny limb and ORG-13's org-scoped team lookup", () => {
    const [file, text] = definitions("node_visible", FILES, 6).at(-1)!;
    expect(file >= FILE, file).toBe(true);
    for (const s of ["'deny'->'roles'->a.act", "'deny'->'teams'->a.act", "'deny'->'orgs'->a.act", "'deny'->'users'->a.act",
      "IF v_normal AND (p_acl_index IS NULL OR NOT EXISTS (", "FROM team_members WHERE uid = auth.uid() AND org_id = p_org;"]) {
      expect(text, `${file} dropped: ${s}`).toContain(s);
    }
  });
});

// ── The agreement matrix (DACL-6 c3 / DACL-12 c3 / IEDGE-12 c1) ──────────────
const ORG = "00000000-0000-0000-0000-000000000001";
const U1 = "00000000-0000-0000-0000-0000000000a1";
const T1 = "00000000-0000-0000-0000-0000000000c1";
const T_OTHER_ORG = "00000000-0000-0000-0000-0000000000c9";
const engineer: Principal = { uid: U1, role: "Engineer" as Role, roles: ["Engineer", "Viewer"] as Role[], orgId: ORG, teamIds: [T1], isActiveMember: true };
const controller: Principal = { uid: "00000000-0000-0000-0000-0000000000a2", role: "Engineer" as Role, roles: ["Engineer", "DocCtrl"] as Role[], orgId: ORG, teamIds: [], isActiveMember: true };

const rule = (effect: "allow" | "deny", type: "user" | "role" | "team" | "org", id: string, ...actions: PermissionAction[]): AccessRule =>
  ({ effect, subject: { type, id }, actions } as AccessRule);

/** A line-for-line port of 20261212's node_visible/6 over an index. The
 *  caller's teams are those of the node's org (ORG-13): the forged other-org
 *  team never reaches it, exactly as the SQL's org-scoped lookup. */
function sqlNodeVisible(vis: NodeVisibility, idx: AclIndex | null, p: Principal, owner: string | null): boolean {
  const normal = vis === "normal";
  const list = (b: "allow" | "deny", s: string, a: string): string[] =>
    ((idx?.[b] as unknown as Record<string, Record<string, string[]>> | undefined)?.[s]?.[a]) ?? [];
  const readDenyAny = ["users", "roles", "teams", "orgs"].some((s) => list("deny", s, "read").length > 0);
  if (normal && (!idx || !readDenyAny)) return true;
  const roles = [p.role, ...(p.roles ?? [])] as string[];
  const controller = roles.some((r) => r === "Admin" || r === "DocCtrl");
  const isOwner = !!owner && owner === p.uid;
  // private / hidden: the controller check and the cascade first (20261203's order)
  if (!normal && controller) return true;
  if (!normal && isOwner) return true;
  if (!idx) return false;
  const teams = p.teamIds ?? [];
  const acts = normal ? ["read"] : ["read", "discover"];
  const denied = acts.some((a) => list("deny", "users", a).includes(p.uid) || (!!p.orgId && list("deny", "orgs", a).includes(p.orgId))
    || roles.some((r) => list("deny", "roles", a).includes(r)) || teams.some((t) => list("deny", "teams", a).includes(t)));
  // normal: asked only once the deny names the caller (second review fix — cost)
  if (denied) return normal ? controller || isOwner : false;
  if (normal) return true;
  const allowAny = (s: string, ids: string[]) => Object.values(((idx.allow as unknown as Record<string, Record<string, string[]>>)[s]) ?? {})
    .some((l) => Array.isArray(l) && l.some((x) => ids.includes(x)));
  return allowAny("users", [p.uid]) || allowAny("roles", roles) || allowAny("teams", teams);
}

interface Case { n: number; name: string; vis: NodeVisibility; rules: AccessRule[]; who: Principal; owner?: string; app: boolean; pg16: boolean }
const CASES: Case[] = [
  { n: 1, name: "private: allow read to role Engineer", vis: "private", rules: [rule("allow", "role", "Engineer", "read")], who: engineer, app: true, pg16: true },
  { n: 2, name: "private: allow read Engineer, DENY read to the secondary role Viewer", vis: "private", rules: [rule("allow", "role", "Engineer", "read"), rule("deny", "role", "Viewer", "read")], who: engineer, app: false, pg16: false },
  { n: 3, name: "private: allow discover Engineer, DENY read to team c1 (the finding's scenario)", vis: "private", rules: [rule("allow", "role", "Engineer", "discover"), rule("deny", "team", T1, "read")], who: engineer, app: false, pg16: false },
  { n: 4, name: "private: DENY read to the workspace, allow read to the user", vis: "private", rules: [rule("allow", "user", U1, "read"), rule("deny", "org", ORG, "read")], who: engineer, app: false, pg16: false },
  { n: 5, name: "private: allow read Engineer, DENY discover to the user", vis: "private", rules: [rule("allow", "role", "Engineer", "read"), rule("deny", "user", U1, "discover")], who: engineer, app: true, pg16: false },
  { n: 6, name: "private: DENY read to role Engineer, caller a controller (DocCtrl held additively)", vis: "private", rules: [rule("deny", "role", "Engineer", "read")], who: controller, app: true, pg16: true },
  { n: 7, name: "private: DENY read to role Engineer, caller the effective owner", vis: "private", rules: [rule("deny", "role", "Engineer", "read")], who: engineer, owner: U1, app: true, pg16: true },
  { n: 8, name: "private: DENY read to a team of ANOTHER org the caller is (forged) in", vis: "private", rules: [rule("allow", "role", "Engineer", "read"), rule("deny", "team", T_OTHER_ORG, "read")], who: engineer, app: true, pg16: true },
  { n: 9, name: "hidden: allow discover only to Engineer", vis: "hidden", rules: [rule("allow", "role", "Engineer", "discover")], who: engineer, app: false /* canReadNode asks read; the page's canDiscover lists it */, pg16: true },
  { n: 10, name: "private: no grant names the caller", vis: "private", rules: [rule("allow", "role", "Operations", "read")], who: engineer, app: false, pg16: false },
  { n: 11, name: "normal: no rules", vis: "normal", rules: [], who: engineer, app: true, pg16: true },
  { n: 12, name: "normal: DENY read to role Engineer", vis: "normal", rules: [rule("deny", "role", "Engineer", "read")], who: engineer, app: false, pg16: false },
  { n: 13, name: "normal: allow read Engineer, DENY read to the secondary role Viewer", vis: "normal", rules: [rule("allow", "role", "Engineer", "read"), rule("deny", "role", "Viewer", "read")], who: engineer, app: false, pg16: false },
  { n: 14, name: "normal: DENY read to team c1", vis: "normal", rules: [rule("deny", "team", T1, "read")], who: engineer, app: false, pg16: false },
  { n: 15, name: "normal: DENY read to the user", vis: "normal", rules: [rule("deny", "user", U1, "read")], who: engineer, app: false, pg16: false },
  { n: 16, name: "normal: DENY read to role Operations (not the caller), allow read to Engineer", vis: "normal", rules: [rule("deny", "role", "Operations", "read"), rule("allow", "role", "Engineer", "read")], who: engineer, app: true, pg16: true },
  { n: 17, name: "normal: DENY read to role Engineer, caller the effective owner", vis: "normal", rules: [rule("deny", "role", "Engineer", "read")], who: engineer, owner: U1, app: true, pg16: true },
  { n: 18, name: "normal: DENY read to role Engineer, caller a controller", vis: "normal", rules: [rule("deny", "role", "Engineer", "read")], who: controller, app: true, pg16: true },
  { n: 19, name: "normal: DENY read Engineer AND allow admin to Engineer (a deny of the action wins, OWN-8)", vis: "normal", rules: [rule("allow", "role", "Engineer", "admin"), rule("deny", "role", "Engineer", "read")], who: engineer, app: false, pg16: false },
  { n: 21, name: "normal: an allow-list naming another role only", vis: "normal", rules: [rule("allow", "role", "Operations", "read")], who: engineer, app: false, pg16: true },
  { n: 22, name: "private: allow UPLOAD only to the user", vis: "private", rules: [rule("allow", "user", U1, "upload")], who: engineer, app: false, pg16: true },
  { n: 23, name: "normal: DENY discover only to Engineer, allow read to Engineer", vis: "normal", rules: [rule("deny", "role", "Engineer", "discover"), rule("allow", "role", "Engineer", "read")], who: engineer, app: true, pg16: true },
];
// The residuals the database does not mirror (recorded on DACL-1 / DACL-6 /
// DACL-12): a normal row is open to anyone its index does not DENY (21); a
// private / hidden row lists for any allowed action (22, and 9 — where the
// app's canDiscover lists it too; canReadNode asks read); and a discover
// deny on a private / hidden row hides it from the database even where the
// app would let the subject read it (5 — the user-scoped branch did this
// before 20261212; an under-disclosure, never a grant).
const RESIDUAL = new Set([5, 9, 21, 22]);

describe("the agreement matrix — app (canReadNode) vs 20261212's node_visible", () => {
  for (const c of CASES) {
    it(`${c.n}. ${c.name}`, () => {
      const app = canReadNode({ principal: c.who, aclChain: [{ inherit: true, visibility: c.vis, rules: c.rules }], visibility: c.vis, effectiveOwnerUserId: c.owner ?? null });
      expect(app, "app").toBe(c.app);
      const db = sqlNodeVisible(c.vis, buildAclIndexFromRules(c.rules), { ...c.who, teamIds: (c.who.teamIds ?? []).filter((t) => t !== T_OTHER_ORG) }, c.owner ?? null);
      // the port reproduces what the SQL returned on PostgreSQL 16
      expect(db, "port vs PG16").toBe(c.pg16);
      if (RESIDUAL.has(c.n)) expect(db).not.toBe(app);
      else expect(db, "app and database agree").toBe(app);
    });
  }

  it("the emptyBucket shape (every list present, all empty) takes the normal fast path", () => {
    const idx = buildAclIndexFromRules([rule("allow", "role", "Engineer", "read")])!;
    expect(Object.values(idx.deny.roles).every((l) => l.length === 0)).toBe(true);
    expect(sqlNodeVisible("normal", idx, engineer, null)).toBe(true);
  });
});
