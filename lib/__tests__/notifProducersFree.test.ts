// notifications Round G — N8 PRODUCERS-FREE, the database half:
// supabase/migrations/20261181_notif_roundG_producers_free.sql.
//
//   · notification_kinds() re-created from its NEWEST definition (found by
//     scanning supabase/migrations below this file) with exactly four rows
//     added — the kinds N8 registers in lib/notificationKinds.ts KIND_META —
//     and nothing removed (lineDiff);
//   · clear_resolved_branch_alerts(uuid) — PROD-3 dw2: SECURITY DEFINER,
//     search_path pinned, EXECUTE to authenticated only, acts on a RESOLVED
//     branch of an org the caller is ACTIVE in, writes read_at only;
//   · the backlog UPDATE, and the DEC-30 one-paste shape.
// No database in this suite: the SQL is pinned by shape; the app half is in
// lib/__tests__/producers.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KIND_META } from "@/lib/notificationKinds";
import { EXPECTED_FUNCTIONS } from "@/lib/schemaExpectations";

const ROOT = process.cwd();
const DIR = join(ROOT, "supabase", "migrations");
const FILE = "20261181_notif_roundG_producers_free.sql";
const FILES = readdirSync(DIR).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const SQL = read(FILE);
const strip = (sql: string) => sql.replace(/--[^\n]*/g, "");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const CODE = strip(SQL);
const NEW_KINDS = ["change_order_status", "milestone_assigned", "milestone_slipped", "access_request_pending"];

/** Every `CREATE OR REPLACE FUNCTION name(` body in [file, text] order. */
function definitionsOf(name: string, files: string[]): Array<[string, string]> {
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
      out.push([f, s.slice(m.index!, end + tag[0].length + 1)]);
    }
  }
  return out;
}
const lineDiff = (a: string, b: string) => {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
};

describe("20261181 — one paste for the SQL editor (DEC-30)", () => {
  it("opens with a header; stops first when 20261160 is missing; inventory in a TEMP table BEFORE the one BEGIN … COMMIT", () => {
    expect(SQL.startsWith("-- ─")).toBe(true);
    const guard = CODE.indexOf("RAISE EXCEPTION '20261181 needs 20261160");
    const temp = CODE.indexOf("CREATE TEMP TABLE notif_round_g_181_before");
    expect(guard).toBeGreaterThan(0);
    expect(temp).toBeGreaterThan(guard);
    expect(CODE.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(CODE.match(/^COMMIT;/gm)).toHaveLength(1);
    expect(temp).toBeLessThan(CODE.indexOf("BEGIN;"));
  });

  it("ends with ONE statement after COMMIT: the (check, ok, n) probes, then the inventory rows", () => {
    const tail = CODE.slice(CODE.indexOf("COMMIT;") + "COMMIT;".length);
    const statements = tail.replace(/'(?:[^']|'')*'/g, "''").split(";").filter((x) => x.trim());
    expect(statements).toHaveLength(1);
    expect(tail).toMatch(/AS check,[\s\S]*?AS ok,\s*NULL::text AS n/);
    expect(tail).toMatch(/SELECT inventory, NULL::boolean, n FROM \(SELECT inventory, n FROM notif_round_g_181_before ORDER BY ord\) b;/);
  });

  it("the inventory is aggregate counts only — never a customer row", () => {
    const inv = CODE.slice(CODE.indexOf("CREATE TEMP TABLE"), CODE.indexOf("BEGIN;"));
    const branches = inv.split(/UNION ALL/);
    expect(branches).toHaveLength(4);
    for (const b of branches) expect(b).toMatch(/COUNT\(\*\)|COUNT\(DISTINCT/);
    expect(inv).not.toMatch(/SELECT \*|title|body|actor_name|display_name|\bemail\b/i);
  });

  it("DRLS-16: every SECURITY DEFINER function pins search_path, is REVOKEd from PUBLIC and anon, and GRANTed only to authenticated", () => {
    const defs = [...CODE.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(([^)]*)\)\s*RETURNS[\s\S]*?AS \$\$/g)];
    expect(defs.map((d) => d[1])).toEqual(["notification_kinds", "clear_resolved_branch_alerts"]);
    for (const d of defs) {
      expect(d[0], d[1]).toMatch(/SET search_path = public/);
      if (/SECURITY DEFINER/.test(d[0])) {
        expect(CODE).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${d[1]}\\(uuid\\) FROM PUBLIC, anon;`));
        expect(CODE).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${d[1]}\\(uuid\\) TO authenticated;`));
        expect(CODE).not.toMatch(new RegExp(`GRANT[^;]*${d[1]}[^;]*\\b(anon|PUBLIC|service_role)\\b`));
      }
    }
  });

  it("never touches a notifications policy or the insert rail's trigger function (20261160 / 20261161 own them)", () => {
    expect(CODE).not.toMatch(/(?:DROP|CREATE|ALTER) POLICY/);
    expect(CODE).not.toMatch(/CREATE OR REPLACE FUNCTION enforce_notification_(insert|update)/);
    expect(CODE).not.toMatch(/DROP TRIGGER|CREATE TRIGGER/);
  });
});

describe("20261181 — notification_kinds() re-created from its NEWEST definition, plus N8's four kinds", () => {
  const before = definitionsOf("notification_kinds", FILES.filter((f) => f < FILE)).at(-1)!;
  const mine = definitionsOf("notification_kinds", [FILE]);

  it("the newest earlier definition is found by scanning the sequence (today 20261160 §1), and this file defines it once", () => {
    expect(before[0]).toBe("20261160_notif_roundG_write_rails.sql");
    expect(mine).toHaveLength(1);
  });

  it("removes no line and adds exactly the four rows, none of them a compliance kind", () => {
    const d = lineDiff(before[1], mine[0][1]);
    expect(d.onlyInA).toEqual([]);
    expect(d.onlyInB.map((l) => l.trim())).toEqual(NEW_KINDS.map((k) => expect.stringMatching(new RegExp(`^\\('${k}',\\s+false\\),$`))));
  });

  it("is the newest definition in the whole sequence today, and equals KIND_META kind for kind, flag for flag (the parity notificationWriteRails pins)", () => {
    expect(definitionsOf("notification_kinds", FILES).at(-1)![0]).toBe(FILE);
    const values = [...mine[0][1].matchAll(/\('(\w+)',\s*(true|false)\)/g)].map((m) => [m[1], m[2] === "true"] as const);
    expect(values.map(([k]) => k)).toEqual(Object.keys(KIND_META));
    for (const [k, c] of values) expect(c, k).toBe(KIND_META[k as keyof typeof KIND_META].compliance);
    for (const k of NEW_KINDS) expect(Object.keys(KIND_META), k).toContain(k);
    const n = values.length, c = values.filter(([, x]) => x).length;
    expect([n, c]).toEqual([55, 15]);
    expect(SQL).toContain(`COUNT(*) = ${n} AND COUNT(DISTINCT kind) = ${n} AND COUNT(*) FILTER (WHERE compliance) = ${c}`);
  });

  it("restates EXECUTE: authenticated and service_role, never PUBLIC or anon", () => {
    expect(CODE).toContain("REVOKE ALL ON FUNCTION notification_kinds() FROM PUBLIC, anon;");
    expect(CODE).toContain("GRANT EXECUTE ON FUNCTION notification_kinds() TO authenticated, service_role;");
  });
});

describe("20261181 — clear_resolved_branch_alerts(uuid): the branch_open queue clears itself (PROD-3 dw2)", () => {
  const fn = definitionsOf("clear_resolved_branch_alerts", [FILE])[0][1];
  const body = squash(strip(fn));

  it("SECURITY DEFINER, search_path pinned, returns integer", () => {
    expect(fn).toMatch(/RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/);
  });

  it("no signed-in caller → 0, changes nothing (a NULL auth.uid() is never trusted)", () => {
    expect(body).toContain("v_uid uuid := auth.uid();");
    expect(body.indexOf("IF v_uid IS NULL OR p_branch IS NULL THEN RETURN 0; END IF;")).toBeGreaterThan(0);
    expect(body.indexOf("IF v_uid IS NULL OR p_branch IS NULL THEN")).toBeLessThan(body.indexOf("UPDATE notifications"));
  });

  it("acts only on a RESOLVED branch of an org the caller is ACTIVE in — one answer (0) for every other id", () => {
    expect(body).toContain("SELECT b.org_id INTO v_org FROM revision_branches b WHERE b.id = p_branch AND b.resolved_at IS NOT NULL AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = b.org_id AND m.uid = v_uid AND m.status = 'active');");
    expect(body).toContain("IF v_org IS NULL THEN RETURN 0; END IF;");
    expect(body).not.toMatch(/RAISE EXCEPTION/);   // no refusal that would tell a caller a branch exists elsewhere
  });

  it("marks read only unread branch_open rows about THAT branch, in its org — read_at and nothing else", () => {
    expect(body).toContain("UPDATE notifications n SET read_at = now() WHERE n.org_id = v_org AND n.kind = 'branch_open' AND n.read_at IS NULL AND n.metadata @> jsonb_build_object('branchId', p_branch::text);");
    expect((body.match(/UPDATE /g) ?? []).length).toBe(1);
    expect(body).toContain("GET DIAGNOSTICS v_n = ROW_COUNT; RETURN v_n;");
  });

  it("the key matches what announceBranchOpened writes (metadata: { branchId }) and what resolveBranch passes (p_branch)", () => {
    const branches = readFileSync(join(ROOT, "lib/branches.ts"), "utf8");
    expect(branches).toContain("metadata: { branchId: input.branchId },");
    expect(branches).toContain('supabase.rpc("clear_resolved_branch_alerts", { p_branch: branchId })');
  });

  it("the backlog: the paste marks read the unread alerts of branches ALREADY resolved, by the same rule, inside the transaction; a probe says none are left", () => {
    const tx = CODE.slice(CODE.indexOf("BEGIN;"), CODE.indexOf("COMMIT;"));
    const backlog = squash(tx.slice(tx.lastIndexOf("UPDATE notifications n")));
    expect(backlog).toMatch(/^UPDATE notifications n SET read_at = now\(\) WHERE n\.kind = 'branch_open' AND n\.read_at IS NULL AND EXISTS \(SELECT 1 FROM revision_branches b WHERE b\.resolved_at IS NOT NULL AND b\.org_id = n\.org_id AND n\.metadata @> jsonb_build_object\('branchId', b\.id::text\)\);/);
    expect(SQL).toContain("'AFTER: no unread branch_open row is about a resolved branch'");
  });

  it("the schema-health panel probes it, with an argument its type refuses (the body never runs)", () => {
    const row = EXPECTED_FUNCTIONS.find((f) => f.fn === "clear_resolved_branch_alerts");
    expect(row).toMatchObject({ signature: "clear_resolved_branch_alerts(uuid)", migration: FILE, probeArgs: { p_branch: "schema-health-probe" } });
  });
});
