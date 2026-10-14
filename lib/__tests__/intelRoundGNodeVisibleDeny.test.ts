// intelligence Round G, I-12 DOCUMENT ACL BOUNDARY — 20261212's
// node_visible: an explicit read deny binds for every subject (DACL-12 c1)
// and on a normal row (IEDGE-12 c2 / DACL-1's read-time half).
//
//   · DEC-30 one-paste shape (counts-only TEMP inventory before BEGIN, one
//     BEGIN / COMMIT, one final (check, ok, n) SELECT).
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
    expect(code.indexOf("CREATE TEMP TABLE IF NOT EXISTS intel_i12_20261212_inventory")).toBeLessThan(begin);
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

  it("the only function it creates is node_visible/6: SECURITY DEFINER, search_path pinned, grants deliberately left as they are", () => {
    const creates = [...SQL.matchAll(/^CREATE OR REPLACE FUNCTION (\w+)\(/gm)].map((m) => m[1]);
    expect(creates).toEqual(["node_visible"]);
    expect(SQL).toMatch(/RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS \$\$/);
    expect(SQL).toMatch(/EXECUTE is deliberately left as it is/);
    expect(SQL).not.toMatch(/(REVOKE|GRANT)[^;]*ON FUNCTION node_visible/);
    // no table, policy or trigger is created or changed
    expect(SQL).not.toMatch(/^\s*(CREATE|ALTER|DROP)\s+(TABLE|POLICY|TRIGGER)\b/m);
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
      "  -- A normal row the deny does not name stays open (the fail-safe default).",
      "  IF v_normal THEN",
    ]);
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
  if (roles.some((r) => r === "Admin" || r === "DocCtrl")) return true;
  if (owner && owner === p.uid) return true;
  if (!idx) return false;
  const teams = p.teamIds ?? [];
  const acts = normal ? ["read"] : ["read", "discover"];
  const denied = acts.some((a) => list("deny", "users", a).includes(p.uid) || (!!p.orgId && list("deny", "orgs", a).includes(p.orgId))
    || roles.some((r) => list("deny", "roles", a).includes(r)) || teams.some((t) => list("deny", "teams", a).includes(t)));
  if (denied) return false;
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
